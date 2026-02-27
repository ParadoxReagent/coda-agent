/**
 * SelfImprovementExecutorSkill (Phase 6): Closes the detect→fix→test→PR loop.
 *
 * Scheduled: Monday 2 AM (executor_cron, default "0 2 * * 1")
 * Gate: executor_enabled must be true in config.
 *
 * Tools:
 *   - self_improvement_run    (tier 3) — manually trigger an execution cycle
 *   - self_improvement_status (tier 0) — status of current/last run
 *   - self_improvement_history (tier 0) — past run results from DB
 *
 * Workflow per cycle:
 *   1. Redis lock (prevent concurrent runs)
 *   2. Select highest-priority pending/approved proposal
 *   3. Blast radius analysis (code-archaeologist subagent)
 *   4. Generate fix (code-surgeon subagent)
 *   5. Create branch + push files (GitHub MCP)
 *   6. Build + test + shadow container (test-runner subagent)
 *   7. Create PR (GitHub MCP, only on PASS)
 *   8. Morning report (improvement-reporter subagent)
 *   9. Update DB state
 *  10. Release Redis lock
 */
import type { Skill, SkillToolDefinition } from "../base.js";
import type { SkillContext } from "../context.js";
import type { Database } from "../../db/index.js";
import type { Logger } from "../../utils/logger.js";
import type { MessageSender } from "../../core/message-sender.js";
import type { SubagentManager } from "../../core/subagent-manager.js";
import type { SkillRegistry } from "../registry.js";
import type { AgentLoader } from "../../core/agent-loader.js";
import { improvementProposals, selfImprovementRuns } from "../../db/schema.js";
import { eq, desc, inArray, and } from "drizzle-orm";
import {
  validateChangePaths,
  isBlastRadiusAcceptable,
  isChangeCountAcceptable,
  canAutoMerge,
} from "./guardrails.js";
// runSmokeTests is used by the test-runner agent via docker_sandbox_healthcheck tools
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { runSmokeTests as _runSmokeTests } from "./smoke-tests.js";
import type {
  RunOutcome,
  RunStep,
  BlastRadiusAnalysis,
  SurgeonOutput,
  RunResult,
  ExecutorConfig,
} from "./types.js";

const REDIS_LOCK_KEY = "self_improvement:lock";

export class SelfImprovementExecutorSkill implements Skill {
  readonly name = "self-improvement-executor";
  readonly description = "Automated code fix pipeline for approved self-improvement proposals";
  readonly kind = "skill" as const;

  private db?: Database;
  private logger?: Logger;
  private messageSender?: MessageSender;
  private subagentManager?: SubagentManager;
  private agentLoader?: AgentLoader;
  private skillRegistry?: SkillRegistry;
  private redis?: SkillContext["redis"];
  private config: ExecutorConfig;

  /** Track current run state for status reporting. */
  private currentRunId: string | null = null;
  private currentRunStatus: "idle" | "running" | "complete" = "idle";
  private lastResult: RunResult | null = null;

  constructor(config?: Partial<ExecutorConfig>) {
    this.config = {
      executor_enabled: config?.executor_enabled ?? false,
      executor_require_approval: config?.executor_require_approval ?? true,
      executor_cron: config?.executor_cron ?? "0 2 * * 1",
      executor_max_files: config?.executor_max_files ?? 3,
      executor_blast_radius_limit: config?.executor_blast_radius_limit ?? 5,
      executor_allowed_paths: config?.executor_allowed_paths ?? ["src/skills", "src/integrations", "src/utils"],
      executor_forbidden_paths: config?.executor_forbidden_paths ?? ["src/core", "src/db/migrations", "src/main.ts"],
      executor_auto_merge: false, // Always false (defense in depth)
      executor_shadow_port: config?.executor_shadow_port ?? 3099,
      executor_max_run_duration_minutes: config?.executor_max_run_duration_minutes ?? 45,
      executor_github_owner: config?.executor_github_owner ?? "",
      executor_github_repo: config?.executor_github_repo ?? "",
    };
    // Enforce auto_merge=false regardless of any config passed
    void canAutoMerge();
  }

  // ── Dependency injection setters ─────────────────────────────────────────

  setSubagentManager(manager: SubagentManager): void {
    this.subagentManager = manager;
  }

  setAgentLoader(loader: AgentLoader): void {
    this.agentLoader = loader;
  }

  setSkillRegistry(registry: SkillRegistry): void {
    this.skillRegistry = registry;
  }

  getRequiredConfig(): string[] {
    return [];
  }

  // ── Tool definitions ──────────────────────────────────────────────────────

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "self_improvement_run",
        description:
          "Manually trigger a self-improvement execution cycle. " +
          "Selects the highest-priority approved proposal, generates a code fix, " +
          "runs tests in a shadow container, and opens a PR if tests pass.",
        input_schema: {
          type: "object" as const,
          properties: {
            proposal_id: {
              type: "string",
              description: "Optional: target a specific proposal ID instead of the highest-priority one",
            },
          },
        },
        mainAgentOnly: true,
        requiresConfirmation: true,
        permissionTier: 3,
      },
      {
        name: "self_improvement_status",
        description: "Get status of the current or last self-improvement execution run.",
        input_schema: {
          type: "object" as const,
          properties: {},
        },
        mainAgentOnly: true,
        permissionTier: 0,
      },
      {
        name: "self_improvement_history",
        description: "List past self-improvement execution runs from the database.",
        input_schema: {
          type: "object" as const,
          properties: {
            limit: { type: "number", description: "Max results (default 10)" },
          },
        },
        mainAgentOnly: true,
        permissionTier: 0,
      },
    ];
  }

  // ── Startup / Shutdown ────────────────────────────────────────────────────

  async startup(ctx: SkillContext): Promise<void> {
    this.db = ctx.db;
    this.logger = ctx.logger;
    this.redis = ctx.redis;
    this.messageSender = ctx.messageSender;

    if (!this.config.executor_enabled) {
      this.logger?.info("Self-improvement executor disabled (executor_enabled: false)");
      return;
    }

    if (ctx.scheduler) {
      ctx.scheduler.registerTask({
        name: "self_improvement_execution",
        cronExpression: this.config.executor_cron,
        handler: async () => { await this.runCycle(); },
        enabled: true,
        description: "Weekly self-improvement code fix pipeline (Monday 2 AM)",
      });
      this.logger?.info(
        { cron: this.config.executor_cron },
        "Self-improvement executor scheduled"
      );
    }
  }

  async shutdown(): Promise<void> {}

  // ── Tool execution ────────────────────────────────────────────────────────

  async execute(toolName: string, input: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case "self_improvement_run":
        return this.triggerRun(input);
      case "self_improvement_status":
        return this.getStatus();
      case "self_improvement_history":
        return this.getHistory(input);
      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  }

  private async triggerRun(input: Record<string, unknown>): Promise<string> {
    if (this.currentRunStatus === "running") {
      return JSON.stringify({ error: "A run is already in progress", runId: this.currentRunId });
    }

    const specificProposalId = input.proposal_id as string | undefined;

    // Run async but track status
    this.runCycle(specificProposalId).catch((err) => {
      this.logger?.error({ error: err }, "Self-improvement run failed unexpectedly");
    });

    return JSON.stringify({
      success: true,
      message: "Self-improvement cycle started. Use self_improvement_status to check progress.",
      runId: this.currentRunId,
    });
  }

  private getStatus(): string {
    return JSON.stringify({
      status: this.currentRunStatus,
      runId: this.currentRunId,
      lastResult: this.lastResult
        ? {
            outcome: this.lastResult.outcome,
            proposalId: this.lastResult.proposalId,
            prUrl: this.lastResult.prUrl,
            branchName: this.lastResult.branchName,
            durationMs: this.lastResult.durationMs,
            stepsCount: this.lastResult.steps.length,
          }
        : null,
    });
  }

  private async getHistory(input: Record<string, unknown>): Promise<string> {
    if (!this.db) return JSON.stringify({ error: "Database not initialized" });

    const limit = Math.min((input.limit as number) ?? 10, 50);
    const rows = await this.db
      .select()
      .from(selfImprovementRuns)
      .orderBy(desc(selfImprovementRuns.createdAt))
      .limit(limit);

    return JSON.stringify({
      runs: rows.map((r) => ({
        id: r.id,
        proposalId: r.proposalId,
        outcome: r.outcome,
        branchName: r.branchName,
        prUrl: r.prUrl,
        durationMs: r.durationMs,
        narrative: r.narrative,
        error: r.error,
        createdAt: r.createdAt.toISOString(),
        completedAt: r.completedAt?.toISOString(),
      })),
      total: rows.length,
    });
  }

  // ── Core cycle ────────────────────────────────────────────────────────────

  /**
   * Main self-improvement execution cycle.
   * Protected by a Redis distributed lock to prevent concurrent runs.
   */
  async runCycle(specificProposalId?: string): Promise<void> {
    const runId = crypto.randomUUID();
    this.currentRunId = runId;
    this.currentRunStatus = "running";

    const cycleStart = Date.now();
    const steps: RunStep[] = [];
    let outcome: RunOutcome = "FAIL";
    let branchName: string | undefined;
    let prUrl: string | undefined;
    let blastRadius: BlastRadiusAnalysis | undefined;
    let targetFiles: string[] = [];
    let proposalId: string | undefined;
    let narrative: string | undefined;
    let cycleError: string | undefined;

    // Max run duration enforcement
    const maxDurationMs = this.config.executor_max_run_duration_minutes * 60 * 1000;
    const runAbortController = new AbortController();
    const durationTimeoutHandle = setTimeout(() => {
      runAbortController.abort();
    }, maxDurationMs);

    try {
      // Step 1: Acquire Redis lock
      const locked = await this.acquireLock();
      if (!locked) {
        this.logger?.warn("Self-improvement cycle aborted: lock already held");
        outcome = "SKIPPED";
        cycleError = "Redis lock already held — another run is in progress";
        return;
      }

      try {
        // Step 2: Select target proposal
        const proposal = await this.selectProposal(specificProposalId);
        if (!proposal) {
          this.logger?.info("No eligible proposals found for execution");
          outcome = "SKIPPED";
          cycleError = "No eligible proposals found";
          return;
        }

        proposalId = proposal.id;
        this.logger?.info(
          { proposalId, title: proposal.title, category: proposal.category },
          "Selected proposal for execution"
        );

        // Step 3: Blast radius analysis
        const archaeologistStep = await this.runBlastRadiusAnalysis(proposal, runAbortController.signal);
        steps.push(archaeologistStep);
        if (!archaeologistStep.passed) {
          cycleError = archaeologistStep.error;
          return;
        }

        try {
          blastRadius = JSON.parse(archaeologistStep.output ?? "{}") as BlastRadiusAnalysis;
        } catch {
          blastRadius = undefined;
        }

        if (blastRadius && !isBlastRadiusAcceptable(
          blastRadius.affected_files.length,
          this.config.executor_blast_radius_limit
        )) {
          const errMsg = `Blast radius too large: ${blastRadius.affected_files.length} files > limit ${this.config.executor_blast_radius_limit}`;
          steps.push({ name: "blast-radius-gate", passed: false, durationMs: 0, error: errMsg });
          cycleError = errMsg;
          return;
        }

        // Step 4: Generate fix
        const surgeonStep = await this.runCodeSurgeon(proposal, blastRadius, runAbortController.signal);
        steps.push(surgeonStep);
        if (!surgeonStep.passed) {
          cycleError = surgeonStep.error;
          return;
        }

        let surgeonOutput: SurgeonOutput;
        try {
          surgeonOutput = JSON.parse(surgeonStep.output ?? "{}") as SurgeonOutput;
        } catch {
          steps.push({ name: "surgeon-parse", passed: false, durationMs: 0, error: "Failed to parse surgeon output as JSON" });
          cycleError = "Surgeon output parse error";
          return;
        }

        if (surgeonOutput.out_of_scope) {
          const errMsg = `Proposal out of scope: ${surgeonOutput.out_of_scope_reason ?? "unknown reason"}`;
          steps.push({ name: "scope-gate", passed: false, durationMs: 0, error: errMsg });
          cycleError = errMsg;
          return;
        }

        // Path validation
        targetFiles = surgeonOutput.changes.map((c) => c.file);
        const pathViolations = validateChangePaths(
          targetFiles,
          this.config.executor_allowed_paths,
          this.config.executor_forbidden_paths
        );
        if (pathViolations.length > 0) {
          const errMsg = `Path guardrail violations: ${pathViolations.join("; ")}`;
          steps.push({ name: "path-guardrail", passed: false, durationMs: 0, error: errMsg });
          cycleError = errMsg;
          return;
        }

        if (!isChangeCountAcceptable(surgeonOutput.changes.length, this.config.executor_max_files)) {
          const errMsg = `Too many files to change: ${surgeonOutput.changes.length} > limit ${this.config.executor_max_files}`;
          steps.push({ name: "file-count-gate", passed: false, durationMs: 0, error: errMsg });
          cycleError = errMsg;
          return;
        }

        // Step 5: Create branch + push files
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        branchName = `agent/self-improvement/${timestamp}`;
        const gitStep = await this.createBranchAndPush(
          branchName,
          surgeonOutput,
          proposal,
          runAbortController.signal
        );
        steps.push(gitStep);
        if (!gitStep.passed) {
          cycleError = gitStep.error;
          return;
        }

        // Step 6: Build + test + shadow container
        const testStep = await this.runTestPipeline(
          branchName,
          surgeonOutput,
          runAbortController.signal
        );
        steps.push(...(Array.isArray(testStep) ? testStep : [testStep]));

        const testsPassed = steps.filter((s) => s.name.startsWith("test-")).every((s) => s.passed);
        if (!testsPassed) {
          cycleError = "Test pipeline failed — no PR created";
          // Don't return — still create report
        } else {
          // Step 7: Create PR
          const prStep = await this.createPullRequest(
            branchName,
            proposal,
            surgeonOutput,
            blastRadius,
            steps,
            runAbortController.signal
          );
          steps.push(prStep);
          if (prStep.passed && prStep.output) {
            try {
              const prData = JSON.parse(prStep.output) as { html_url?: string; url?: string };
              prUrl = prData.html_url ?? prData.url;
            } catch {
              // output might be the URL directly
              if (prStep.output.startsWith("http")) prUrl = prStep.output;
            }
          }
          outcome = prStep.passed ? "PASS" : "FAIL";
        }
      } finally {
        await this.releaseLock();
      }
    } catch (err) {
      cycleError = err instanceof Error ? err.message : String(err);
      this.logger?.error({ error: err, runId }, "Self-improvement cycle error");
    } finally {
      clearTimeout(durationTimeoutHandle);

      // Always clean up any lingering sandbox containers
      await this.cleanupSandboxContainers();
    }

    const durationMs = Date.now() - cycleStart;

    // Step 8: Report (best-effort — never block on reporter failure)
    try {
      if (proposalId) {
        const proposal = await this.db?.select()
          .from(improvementProposals)
          .where(eq(improvementProposals.id, proposalId))
          .limit(1);
        const proposalData = proposal?.[0];

        narrative = await this.runReporter(
          outcome,
          proposalData,
          branchName,
          prUrl,
          steps,
          blastRadius,
          cycleError,
          runAbortController.signal
        );
      }
    } catch (err) {
      this.logger?.warn({ error: err }, "Reporter failed (non-fatal)");
    }

    // Step 9: Update DB
    if (proposalId) {
      try {
        await this.db?.insert(selfImprovementRuns).values({
          proposalId,
          outcome,
          branchName: branchName ?? null,
          prUrl: prUrl ?? null,
          targetFiles,
          steps,
          blastRadius: blastRadius ?? {},
          narrative: narrative ?? null,
          error: cycleError ?? null,
          durationMs,
          completedAt: new Date(),
        });

        // Update proposal status on success
        if (outcome === "PASS") {
          await this.db?.update(improvementProposals)
            .set({ status: "applied", appliedAt: new Date() })
            .where(eq(improvementProposals.id, proposalId));
        }
      } catch (err) {
        this.logger?.error({ error: err }, "Failed to persist run record");
      }
    }

    this.lastResult = {
      runId,
      proposalId: proposalId ?? "unknown",
      outcome,
      branchName,
      prUrl,
      targetFiles,
      steps,
      blastRadius,
      narrative,
      error: cycleError,
      durationMs,
    };
    this.currentRunStatus = "complete";

    this.logger?.info(
      { runId, outcome, proposalId, prUrl, durationMs },
      "Self-improvement cycle complete"
    );
  }

  // ── Sub-steps ─────────────────────────────────────────────────────────────

  private async selectProposal(specificId?: string): Promise<typeof improvementProposals.$inferSelect | undefined> {
    if (!this.db) return undefined;

    if (specificId) {
      const [row] = await this.db
        .select()
        .from(improvementProposals)
        .where(eq(improvementProposals.id, specificId))
        .limit(1);
      return row;
    }

    const eligibleStatuses = this.config.executor_require_approval
      ? ["approved"]
      : ["approved", "pending"];

    const eligibleCategories = ["capability_gap", "failure_mode", "tool_usage", "routing"];

    const [row] = await this.db
      .select()
      .from(improvementProposals)
      .where(
        and(
          inArray(improvementProposals.status, eligibleStatuses),
          inArray(improvementProposals.category, eligibleCategories)
        )
      )
      .orderBy(desc(improvementProposals.priority), improvementProposals.createdAt)
      .limit(1);

    return row;
  }

  private async runBlastRadiusAnalysis(
    proposal: typeof improvementProposals.$inferSelect,
    _signal: AbortSignal
  ): Promise<RunStep> {
    const start = Date.now();
    if (!this.subagentManager) {
      return { name: "blast-radius", passed: false, durationMs: 0, error: "SubagentManager not injected" };
    }

    const agentDef = this.agentLoader?.getAgent("code-archaeologist");

    try {
      const task = [
        `Analyze blast radius for the following improvement proposal:`,
        `Title: ${proposal.title}`,
        `Category: ${proposal.category}`,
        `Description: ${proposal.description}`,
        ``,
        `Return a JSON object with the blast radius analysis.`,
        `Focus on files under: ${this.config.executor_allowed_paths.join(", ")}`,
        ``,
        `If you cannot identify specific target files from the proposal description,`,
        `return an analysis with affected_files: [] and risk_level: "low".`,
      ].join("\n");

      const result = await this.subagentManager.delegateSync(
        "system",
        "system",
        task,
        {
          toolsNeeded: ["memory_search", "memory_save"],
          workerName: "code-archaeologist",
          workerInstructions: agentDef?.systemPrompt,
          tokenBudget: agentDef?.tokenBudget ?? 50000,
          preferredModel: agentDef?.defaultModel ?? undefined,
        }
      );

      // Try to extract JSON from the result
      let parsed: BlastRadiusAnalysis | null = null;
      try {
        // Result may contain prose + JSON — try to find the JSON block
        const jsonMatch = result.match(/\{[\s\S]*"affected_files"[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]) as BlastRadiusAnalysis;
        } else {
          parsed = JSON.parse(result) as BlastRadiusAnalysis;
        }
      } catch {
        // If parsing fails, use a safe default
        parsed = {
          affected_files: [],
          import_chain_depth: 0,
          risk_level: "low",
          risk_factors: ["Could not parse blast radius analysis"],
          protected_path_violations: [],
          summary: "Blast radius analysis parsing failed — treating as safe",
        };
      }

      return {
        name: "blast-radius",
        passed: true,
        durationMs: Date.now() - start,
        output: JSON.stringify(parsed),
      };
    } catch (err) {
      return {
        name: "blast-radius",
        passed: false,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async runCodeSurgeon(
    proposal: typeof improvementProposals.$inferSelect,
    blastRadius: BlastRadiusAnalysis | undefined,
    _signal: AbortSignal
  ): Promise<RunStep> {
    const start = Date.now();
    if (!this.subagentManager) {
      return { name: "code-surgeon", passed: false, durationMs: 0, error: "SubagentManager not injected" };
    }

    const agentDef = this.agentLoader?.getAgent("code-surgeon");

    const task = [
      `Generate a minimum viable code fix for the following improvement proposal:`,
      ``,
      `Title: ${proposal.title}`,
      `Category: ${proposal.category}`,
      `Priority: ${proposal.priority}/10`,
      `Description: ${proposal.description}`,
      ``,
      `Blast radius analysis:`,
      JSON.stringify(blastRadius ?? {}, null, 2),
      ``,
      `Constraints:`,
      `- Only modify files under: ${this.config.executor_allowed_paths.join(", ")}`,
      `- Never modify: ${this.config.executor_forbidden_paths.join(", ")}`,
      `- Maximum ${this.config.executor_max_files} files`,
      ``,
      `Return a JSON object with the SurgeonOutput schema.`,
      `If this proposal cannot be safely auto-applied, set out_of_scope: true.`,
    ].join("\n");

    try {
      const result = await this.subagentManager.delegateSync(
        "system",
        "system",
        task,
        {
          toolsNeeded: ["memory_search", "memory_save"],
          workerName: "code-surgeon",
          workerInstructions: agentDef?.systemPrompt,
          tokenBudget: agentDef?.tokenBudget ?? 100000,
          preferredModel: agentDef?.defaultModel ?? undefined,
        }
      );

      // Extract JSON
      let parsed: SurgeonOutput | null = null;
      try {
        const jsonMatch = result.match(/\{[\s\S]*"changes"[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]) as SurgeonOutput;
        } else {
          parsed = JSON.parse(result) as SurgeonOutput;
        }
      } catch {
        return {
          name: "code-surgeon",
          passed: false,
          durationMs: Date.now() - start,
          error: "Could not parse surgeon output as JSON",
          output: result.slice(0, 1000),
        };
      }

      return {
        name: "code-surgeon",
        passed: true,
        durationMs: Date.now() - start,
        output: JSON.stringify(parsed),
      };
    } catch (err) {
      return {
        name: "code-surgeon",
        passed: false,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async createBranchAndPush(
    branchName: string,
    surgeonOutput: SurgeonOutput,
    proposal: typeof improvementProposals.$inferSelect,
    _signal: AbortSignal
  ): Promise<RunStep> {
    const start = Date.now();
    if (!this.skillRegistry) {
      return { name: "git-push", passed: false, durationMs: 0, error: "SkillRegistry not injected" };
    }

    try {
      // Create branch via GitHub MCP
      await this.skillRegistry.executeToolCall("create_branch", {
        owner: this.config.executor_github_owner,
        repo: this.config.executor_github_repo,
        branch: branchName,
        from_branch: "main",
      });

      // Push each changed file
      for (const change of surgeonOutput.changes) {
        await this.skillRegistry.executeToolCall("create_or_update_file", {
          owner: this.config.executor_github_owner,
          repo: this.config.executor_github_repo,
          path: change.file,
          content: Buffer.from(change.newContents).toString("base64"),
          message: `[Agent] Fix: ${proposal.title.slice(0, 70)}\n\n${change.explanation}`,
          branch: branchName,
        });
      }

      return {
        name: "git-push",
        passed: true,
        durationMs: Date.now() - start,
        output: `Branch ${branchName} created with ${surgeonOutput.changes.length} file(s)`,
      };
    } catch (err) {
      return {
        name: "git-push",
        passed: false,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async runTestPipeline(
    branchName: string,
    _surgeonOutput: SurgeonOutput,
    _signal: AbortSignal
  ): Promise<RunStep[]> {
    if (!this.subagentManager) {
      return [{ name: "test-pipeline", passed: false, durationMs: 0, error: "SubagentManager not injected" }];
    }

    const agentDef = this.agentLoader?.getAgent("test-runner");
    const containerName = `agent-sandbox-${Date.now()}`;
    const imageTag = `agent-sandbox-run-${Date.now()}:latest`;
    const start = Date.now();

    const task = [
      `Run the validation pipeline for branch: ${branchName}`,
      ``,
      `Steps (in order):`,
      `1. Run: pnpm run build  (compile check — abort on failure)`,
      `2. Run: pnpm test       (compare failure count to baseline of 35)`,
      `3. Build Docker image: docker_sandbox_build with tag "${imageTag}"`,
      `   - Dockerfile: Dockerfile (project root)`,
      `   - Context: . (project root)`,
      `4. Run container: docker_sandbox_run`,
      `   - name: "${containerName}"`,
      `   - image: "${imageTag}"`,
      `   - host_port: ${this.config.executor_shadow_port}`,
      `5. Wait 10 seconds, then: docker_sandbox_healthcheck on port ${this.config.executor_shadow_port}`,
      `6. Run 3 smoke tests (startup-check, service-status, basic-liveness)`,
      `7. ALWAYS: docker_sandbox_stop then docker_sandbox_remove "${containerName}"`,
      ``,
      `Return a JSON object with the test pipeline results per step.`,
      `Baseline test failures: 35 (any new failures = FAIL for that step)`,
    ].join("\n");

    try {
      const result = await this.subagentManager.delegateSync(
        "system",
        "system",
        task,
        {
          toolsNeeded: [
            "docker_sandbox_build",
            "docker_sandbox_run",
            "docker_sandbox_logs",
            "docker_sandbox_stop",
            "docker_sandbox_remove",
            "docker_sandbox_healthcheck",
            "memory_save",
          ],
          workerName: "test-runner",
          workerInstructions: agentDef?.systemPrompt,
          tokenBudget: agentDef?.tokenBudget ?? 50000,
          maxToolCalls: agentDef?.maxToolCalls ?? 40,
        }
      );

      return [{
        name: "test-pipeline",
        passed: result.includes('"overall":"PASS"') || result.includes('"overall": "PASS"'),
        durationMs: Date.now() - start,
        output: result.slice(0, 2000),
      }];
    } catch (err) {
      return [{
        name: "test-pipeline",
        passed: false,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      }];
    }
  }

  private async createPullRequest(
    branchName: string,
    proposal: typeof improvementProposals.$inferSelect,
    surgeonOutput: SurgeonOutput,
    blastRadius: BlastRadiusAnalysis | undefined,
    steps: RunStep[],
    _signal: AbortSignal
  ): Promise<RunStep> {
    const start = Date.now();
    if (!this.skillRegistry) {
      return { name: "create-pr", passed: false, durationMs: 0, error: "SkillRegistry not injected" };
    }

    const title = `[Agent] Fix: ${proposal.title}`.slice(0, 70);
    const body = this.buildPrBody(proposal, surgeonOutput, blastRadius, steps);

    try {
      const result = await this.skillRegistry.executeToolCall("create_pull_request", {
        owner: this.config.executor_github_owner,
        repo: this.config.executor_github_repo,
        title,
        body,
        head: branchName,
        base: "main",
        draft: false,
      });

      return {
        name: "create-pr",
        passed: true,
        durationMs: Date.now() - start,
        output: result,
      };
    } catch (err) {
      return {
        name: "create-pr",
        passed: false,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private buildPrBody(
    proposal: typeof improvementProposals.$inferSelect,
    surgeonOutput: SurgeonOutput,
    blastRadius: BlastRadiusAnalysis | undefined,
    steps: RunStep[]
  ): string {
    const now = new Date().toISOString();
    const stepTable = steps
      .map((s) => `| ${s.name} | ${s.passed ? "✅ PASS" : "❌ FAIL"} | ${Math.round(s.durationMs / 1000)}s |`)
      .join("\n");

    const fileList = surgeonOutput.changes
      .map((c) => `- \`${c.file}\`: ${c.explanation}`)
      .join("\n");

    return [
      `## Self-Improvement Proposal`,
      ``,
      `**Category**: ${proposal.category}`,
      `**Priority**: ${proposal.priority ?? 5}/10`,
      `**Proposal ID**: ${proposal.id}`,
      ``,
      `### What This Fixes`,
      ``,
      proposal.description,
      ``,
      `### Files Changed`,
      ``,
      fileList || "_No files listed_",
      ``,
      `### Test Results`,
      ``,
      `| Step | Result | Duration |`,
      `|------|--------|----------|`,
      stepTable || "_No steps recorded_",
      ``,
      `### Blast Radius`,
      ``,
      blastRadius
        ? [
            `- **Affected files**: ${blastRadius.affected_files.length}`,
            `- **Risk level**: ${blastRadius.risk_level}`,
            `- **Risk factors**: ${blastRadius.risk_factors.join(", ") || "none"}`,
            `- **Summary**: ${blastRadius.summary}`,
          ].join("\n")
        : "_Blast radius not available_",
      ``,
      `### Caveats`,
      ``,
      `- This PR was generated automatically by coda-agent self-improvement executor`,
      `- Auto-merge is disabled — human review required before merging`,
      `- Review each file change carefully before approving`,
      ``,
      `---`,
      `*Generated by coda-agent self-improvement executor at ${now}*`,
    ].join("\n");
  }

  private async runReporter(
    outcome: RunOutcome,
    proposal: typeof improvementProposals.$inferSelect | undefined,
    branchName: string | undefined,
    prUrl: string | undefined,
    steps: RunStep[],
    _blastRadius: BlastRadiusAnalysis | undefined,
    error: string | undefined,
    _signal: AbortSignal
  ): Promise<string | undefined> {
    if (!this.subagentManager) return undefined;

    const agentDef = this.agentLoader?.getAgent("improvement-reporter");

    const task = [
      `Write a morning narrative for a self-improvement run with the following results:`,
      ``,
      `Outcome: ${outcome}`,
      `Proposal: ${proposal?.title ?? "Unknown"}`,
      `Category: ${proposal?.category ?? "Unknown"}`,
      `Branch: ${branchName ?? "N/A"}`,
      `PR URL: ${prUrl ?? "N/A (no PR created)"}`,
      `Error: ${error ?? "None"}`,
      `Steps passed: ${steps.filter((s) => s.passed).length}/${steps.length}`,
      ``,
      outcome === "PASS" && prUrl
        ? `A PR was successfully created. Mention the PR URL in the narrative.`
        : `No PR was created. Explain why briefly.`,
      ``,
      `Return the narrative text only.`,
    ].join("\n");

    try {
      const narrative = await this.subagentManager.delegateSync(
        "system",
        "system",
        task,
        {
          toolsNeeded: ["memory_search"],
          workerName: "improvement-reporter",
          workerInstructions: agentDef?.systemPrompt,
          tokenBudget: agentDef?.tokenBudget ?? 50000,
        }
      );
      const text = narrative.slice(0, 1000);
      try {
        await this.messageSender?.broadcast(text, "self-improvement-executor");
      } catch {
        // Best-effort delivery — don't let notification failures abort the run
      }
      return text;
    } catch {
      return undefined;
    }
  }

  // ── Redis lock helpers ────────────────────────────────────────────────────

  private async acquireLock(): Promise<boolean> {
    if (!this.redis) return true; // No Redis = no lock (single instance)

    const ttlSeconds = this.config.executor_max_run_duration_minutes * 60;
    const existing = await this.redis.get(REDIS_LOCK_KEY);
    if (existing) return false;

    await this.redis.set(REDIS_LOCK_KEY, "locked", ttlSeconds);
    return true;
  }

  private async releaseLock(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(REDIS_LOCK_KEY);
    } catch (err) {
      this.logger?.warn({ error: err }, "Failed to release self-improvement lock");
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  /**
   * Force-stop and remove any agent-sandbox-* containers that may have leaked.
   * Called in finally block — never throws.
   */
  private async cleanupSandboxContainers(): Promise<void> {
    if (!this.skillRegistry) return;

    try {
      // List running containers with agent-sandbox- prefix via docker ps
      // We use the healthcheck tool as a proxy for "registry is working"
      // Actual cleanup is handled by the test-runner agent, but we add a belt-and-suspenders
      // cleanup here using docker ps --filter name=agent-sandbox-
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);

      const { stdout } = await execFileAsync("docker", [
        "ps", "-a",
        "--filter", "name=agent-sandbox-",
        "--format", "{{.Names}}",
      ]).catch(() => ({ stdout: "" }));

      const containerNames = stdout.trim().split("\n").filter(Boolean);
      for (const name of containerNames) {
        if (name.startsWith("agent-sandbox-")) {
          await execFileAsync("docker", ["rm", "-f", name]).catch(() => {});
          this.logger?.info({ name }, "Cleaned up leaked sandbox container");
        }
      }
    } catch {
      // Non-fatal — don't let cleanup errors surface
    }
  }
}
