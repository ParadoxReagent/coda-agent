import { NWSClient } from "./client.js";
import type { Skill, SkillToolDefinition } from "../../skills/base.js";
import type { SkillContext } from "../../skills/context.js";
import type { SkillRedisClient } from "../../skills/context.js";
import type { Logger } from "../../utils/logger.js";

const DEFAULT_LATITUDE = 42.0314; // Fairview, PA
const DEFAULT_LONGITUDE = -80.2553;
const DEFAULT_TIMEOUT_MS = 10_000;

// Cache TTLs for different data types
const CACHE_TTL_POINTS = 86400; // 24 hours - grid/station mapping is static
const CACHE_TTL_FORECAST = 900; // 15 minutes
const CACHE_TTL_CURRENT = 300; // 5 minutes
const CACHE_TTL_ALERTS = 300; // 5 minutes

interface LocationInfo {
  gridId: string;
  gridX: number;
  gridY: number;
  forecastUrl: string;
  stationId: string;
  city: string;
  state: string;
}

export class WeatherSkill implements Skill {
  readonly name = "weather";
  readonly description =
    "Weather forecast, current conditions, and alerts via National Weather Service";
  readonly kind = "integration" as const;

  private logger!: Logger;
  private client!: NWSClient;
  private redis!: SkillRedisClient;
  private defaultLatitude = DEFAULT_LATITUDE;
  private defaultLongitude = DEFAULT_LONGITUDE;

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "weather_forecast",
        description:
          "Get period forecast (Today, Tonight, Tomorrow, etc.) for a location. Returns up to 14 periods with detailed forecasts.",
        input_schema: {
          type: "object",
          properties: {
            latitude: {
              type: "number",
              description: "Latitude coordinate (defaults to configured location)",
            },
            longitude: {
              type: "number",
              description: "Longitude coordinate (defaults to configured location)",
            },
          },
        },
      },
      {
        name: "weather_current",
        description:
          "Get current weather conditions from the nearest observation station. Includes temperature, humidity, wind, and conditions.",
        input_schema: {
          type: "object",
          properties: {
            latitude: {
              type: "number",
              description: "Latitude coordinate (defaults to configured location)",
            },
            longitude: {
              type: "number",
              description: "Longitude coordinate (defaults to configured location)",
            },
          },
        },
      },
      {
        name: "weather_alerts",
        description:
          "Get active weather watches, warnings, and advisories for a location.",
        input_schema: {
          type: "object",
          properties: {
            latitude: {
              type: "number",
              description: "Latitude coordinate (defaults to configured location)",
            },
            longitude: {
              type: "number",
              description: "Longitude coordinate (defaults to configured location)",
            },
          },
        },
      },
    ];
  }

  async execute(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<string> {
    switch (toolName) {
      case "weather_forecast":
        return this.getForecast(toolInput);
      case "weather_current":
        return this.getCurrentConditions(toolInput);
      case "weather_alerts":
        return this.getAlerts(toolInput);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  getRequiredConfig(): string[] {
    return [];
  }

  async startup(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;
    this.redis = ctx.redis;

    const cfg = ctx.config;
    this.defaultLatitude = (cfg.default_latitude as number) ?? DEFAULT_LATITUDE;
    this.defaultLongitude = (cfg.default_longitude as number) ?? DEFAULT_LONGITUDE;
    const userAgent = (cfg.user_agent as string) ?? "coda-agent/1.0 (weather-integration)";
    const timeoutMs = (cfg.timeout_ms as number) ?? DEFAULT_TIMEOUT_MS;

    this.client = new NWSClient({ userAgent, timeoutMs });
    this.logger.info(
      { lat: this.defaultLatitude, lon: this.defaultLongitude },
      "Weather skill started"
    );
  }

  async shutdown(): Promise<void> {
    this.logger?.info("Weather skill stopped");
  }

  // --- Tool implementations ---

  private async getForecast(input: Record<string, unknown>): Promise<string> {
    const lat = (input.latitude as number) ?? this.defaultLatitude;
    const lon = (input.longitude as number) ?? this.defaultLongitude;
    const cacheKey = `forecast:${lat.toFixed(4)},${lon.toFixed(4)}`;

    // Check cache first
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      this.logger.debug({ lat, lon }, "Returning cached forecast");
      return cached;
    }

    // Resolve location (grid info + station)
    const location = await this.resolveLocation(lat, lon);
    if (!location.success) {
      return JSON.stringify({ success: false, error: location.error });
    }

    const locInfo = location.data!;

    // Get forecast
    const forecastResult = await this.client.getForecast(locInfo.forecastUrl);
    if (!forecastResult.success) {
      return JSON.stringify({ success: false, error: forecastResult.error });
    }

    const response = JSON.stringify({
      success: true,
      location: {
        city: locInfo.city,
        state: locInfo.state,
        latitude: lat,
        longitude: lon,
      },
      generatedAt: forecastResult.generatedAt,
      periods: forecastResult.periods,
    });

    await this.redis.set(cacheKey, response, CACHE_TTL_FORECAST);
    return response;
  }

  private async getCurrentConditions(
    input: Record<string, unknown>
  ): Promise<string> {
    const lat = (input.latitude as number) ?? this.defaultLatitude;
    const lon = (input.longitude as number) ?? this.defaultLongitude;
    const cacheKey = `current:${lat.toFixed(4)},${lon.toFixed(4)}`;

    // Check cache first
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      this.logger.debug({ lat, lon }, "Returning cached current conditions");
      return cached;
    }

    // Resolve location (grid info + station)
    const location = await this.resolveLocation(lat, lon);
    if (!location.success) {
      return JSON.stringify({ success: false, error: location.error });
    }

    const locInfo = location.data!;

    // Get current conditions
    const currentResult = await this.client.getCurrentConditions(
      locInfo.stationId
    );
    if (!currentResult.success) {
      return JSON.stringify({ success: false, error: currentResult.error });
    }

    const response = JSON.stringify({
      success: true,
      location: {
        city: locInfo.city,
        state: locInfo.state,
        latitude: lat,
        longitude: lon,
        stationId: locInfo.stationId,
      },
      temperature: currentResult.temperature,
      temperatureUnit: currentResult.temperatureUnit,
      humidity: currentResult.humidity,
      windSpeed: currentResult.windSpeed,
      windDirection: currentResult.windDirection,
      textDescription: currentResult.textDescription,
      timestamp: currentResult.timestamp,
    });

    await this.redis.set(cacheKey, response, CACHE_TTL_CURRENT);
    return response;
  }

  private async getAlerts(input: Record<string, unknown>): Promise<string> {
    const lat = (input.latitude as number) ?? this.defaultLatitude;
    const lon = (input.longitude as number) ?? this.defaultLongitude;
    const cacheKey = `alerts:${lat.toFixed(4)},${lon.toFixed(4)}`;

    // Check cache first
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      this.logger.debug({ lat, lon }, "Returning cached alerts");
      return cached;
    }

    // Resolve location (for city/state info)
    const location = await this.resolveLocation(lat, lon);
    if (!location.success) {
      return JSON.stringify({ success: false, error: location.error });
    }

    const locInfo = location.data!;

    // Get alerts
    const alertsResult = await this.client.getAlerts(lat, lon);
    if (!alertsResult.success) {
      return JSON.stringify({ success: false, error: alertsResult.error });
    }

    const response = JSON.stringify({
      success: true,
      location: {
        city: locInfo.city,
        state: locInfo.state,
        latitude: lat,
        longitude: lon,
      },
      alerts: alertsResult.alerts,
      count: alertsResult.alerts?.length ?? 0,
    });

    await this.redis.set(cacheKey, response, CACHE_TTL_ALERTS);
    return response;
  }

  /**
   * Resolve location coordinates to grid info and station ID.
   * Uses cached points data if available (24h TTL).
   */
  private async resolveLocation(
    lat: number,
    lon: number
  ): Promise<{ success: boolean; data?: LocationInfo; error?: string }> {
    const cacheKey = `points:${lat.toFixed(4)},${lon.toFixed(4)}`;

    // Check cache first
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      this.logger.debug({ lat, lon }, "Using cached points data");
      return { success: true, data: JSON.parse(cached) as LocationInfo };
    }

    // Get fresh points data
    const pointsResult = await this.client.getPoints(lat, lon);
    if (!pointsResult.success) {
      return { success: false, error: pointsResult.error };
    }

    if (
      !pointsResult.gridId ||
      !pointsResult.gridX ||
      !pointsResult.gridY ||
      !pointsResult.forecastUrl ||
      !pointsResult.stationId
    ) {
      return {
        success: false,
        error: "Incomplete data from NWS /points endpoint",
      };
    }

    const locationInfo: LocationInfo = {
      gridId: pointsResult.gridId,
      gridX: pointsResult.gridX,
      gridY: pointsResult.gridY,
      forecastUrl: pointsResult.forecastUrl,
      stationId: pointsResult.stationId,
      city: pointsResult.city ?? "Unknown",
      state: pointsResult.state ?? "Unknown",
    };

    // Cache for 24 hours
    await this.redis.set(
      cacheKey,
      JSON.stringify(locationInfo),
      CACHE_TTL_POINTS
    );

    return { success: true, data: locationInfo };
  }
}
