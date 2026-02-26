/**
 * Smoke Test Harness for shadow container validation.
 *
 * Runs lightweight HTTP checks against a shadow container to verify it started
 * correctly before a PR is created. All tests are read-only HTTP GETs.
 */

export interface SmokeTestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  statusCode?: number;
  body?: string;
}

export interface SmokeTestSuiteResult {
  passed: boolean;
  totalMs: number;
  tests: SmokeTestResult[];
}

const PER_TEST_TIMEOUT_MS = 10_000;
const SUITE_TIMEOUT_MS = 60_000;

/**
 * Run the smoke test suite against a shadow container.
 * @param port - The host port the shadow container is bound to.
 * @returns Suite result with per-test details.
 */
export async function runSmokeTests(port: number): Promise<SmokeTestSuiteResult> {
  const suiteStart = Date.now();
  const tests: SmokeTestResult[] = [];

  const testDefinitions: Array<{
    name: string;
    run: () => Promise<SmokeTestResult>;
  }> = [
    {
      name: "startup-check",
      run: () => httpGetTest(port, "/health", "startup-check", (status, _body) => status === 200),
    },
    {
      name: "service-status",
      run: () =>
        httpGetTest(port, "/health", "service-status", (_status, body) => {
          // Accept if no service is explicitly in "error" state
          // Body might be JSON like { status: "ok", services: { redis: "ok", db: "ok" } }
          try {
            const parsed = JSON.parse(body ?? "{}");
            const services = parsed.services ?? {};
            const hasError = Object.values(services).some((s) => s === "error");
            return !hasError;
          } catch {
            // Non-JSON body is fine — just check it returned something
            return true;
          }
        }),
    },
    {
      name: "basic-liveness",
      run: () =>
        httpGetTest(port, "/health", "basic-liveness", (status, _body) => status < 500),
    },
  ];

  // Run all tests with suite-level timeout
  const suiteController = new AbortController();
  const suiteTimeoutHandle = setTimeout(() => suiteController.abort(), SUITE_TIMEOUT_MS);

  try {
    for (const def of testDefinitions) {
      if (suiteController.signal.aborted) {
        tests.push({
          name: def.name,
          passed: false,
          durationMs: 0,
          error: "Suite timeout exceeded",
        });
        continue;
      }

      try {
        const result = await def.run();
        tests.push(result);
      } catch (err) {
        tests.push({
          name: def.name,
          passed: false,
          durationMs: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    clearTimeout(suiteTimeoutHandle);
  }

  const allPassed = tests.every((t) => t.passed);
  return {
    passed: allPassed,
    totalMs: Date.now() - suiteStart,
    tests,
  };
}

/**
 * Execute a single HTTP GET smoke test.
 */
async function httpGetTest(
  port: number,
  path: string,
  name: string,
  check: (status: number, body: string | undefined) => boolean
): Promise<SmokeTestResult> {
  const start = Date.now();
  const url = `http://localhost:${port}${path}`;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), PER_TEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutHandle);

    const body = await res.text().catch(() => undefined);
    const passed = check(res.status, body);

    return {
      name,
      passed,
      durationMs: Date.now() - start,
      statusCode: res.status,
      body: body?.slice(0, 500),
      error: passed ? undefined : `Check failed: HTTP ${res.status}`,
    };
  } catch (err) {
    clearTimeout(timeoutHandle);
    const isTimeout =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("abort"));

    return {
      name,
      passed: false,
      durationMs: Date.now() - start,
      error: isTimeout
        ? `Timeout after ${PER_TEST_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}
