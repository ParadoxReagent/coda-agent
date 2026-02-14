/**
 * Thin HTTP client for National Weather Service (NWS) API.
 * Uses native fetch — no SDK dependency.
 * Free API, no API key required — just a User-Agent header.
 */

export interface NWSClientOptions {
  userAgent: string;
  timeoutMs: number;
}

export interface PointsResult {
  success: boolean;
  gridId?: string;
  gridX?: number;
  gridY?: number;
  forecastUrl?: string;
  stationId?: string;
  city?: string;
  state?: string;
  error?: string;
}

export interface ForecastPeriod {
  name: string;
  isDaytime: boolean;
  temperature: number;
  temperatureUnit: string;
  windSpeed: string;
  windDirection: string;
  shortForecast: string;
  detailedForecast: string;
}

export interface ForecastResult {
  success: boolean;
  generatedAt?: string;
  periods?: ForecastPeriod[];
  error?: string;
}

export interface CurrentConditions {
  success: boolean;
  temperature?: number;
  temperatureUnit?: string;
  humidity?: number;
  windSpeed?: number;
  windDirection?: number;
  textDescription?: string;
  icon?: string;
  timestamp?: string;
  error?: string;
}

export interface Alert {
  id: string;
  event: string;
  severity: string;
  headline: string;
  description: string;
  instruction: string;
  onset: string;
  expires: string;
}

export interface AlertsResult {
  success: boolean;
  alerts?: Alert[];
  error?: string;
}

const NWS_BASE_URL = "https://api.weather.gov";

export class NWSClient {
  private userAgent: string;
  private timeoutMs: number;

  constructor(options: NWSClientOptions) {
    this.userAgent = options.userAgent;
    this.timeoutMs = options.timeoutMs;
  }

  /**
   * Get grid coordinates, forecast URL, and nearest observation station for a location.
   * Two-step process:
   * 1. Get /points/{lat},{lon} for grid info
   * 2. Fetch observationStations URL to get first station ID
   */
  async getPoints(lat: number, lon: number): Promise<PointsResult> {
    // Step 1: Get grid info from /points
    const pointsUrl = `${NWS_BASE_URL}/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
    const pointsData = await this.get<{
      properties?: {
        gridId?: string;
        gridX?: number;
        gridY?: number;
        forecast?: string;
        observationStations?: string;
        relativeLocation?: {
          properties?: {
            city?: string;
            state?: string;
          };
        };
      };
    }>(pointsUrl);

    if (!pointsData.properties) {
      return {
        success: false,
        error: "Invalid response from NWS /points endpoint",
      };
    }

    const props = pointsData.properties;
    const city = props.relativeLocation?.properties?.city;
    const state = props.relativeLocation?.properties?.state;
    const observationStationsUrl = props.observationStations;

    // Step 2: Get first station ID from observationStations URL
    let stationId: string | undefined;
    if (observationStationsUrl) {
      const stationsData = await this.get<{
        features?: Array<{
          properties?: {
            stationIdentifier?: string;
          };
        }>;
      }>(observationStationsUrl);

      if (stationsData.features && stationsData.features.length > 0) {
        const firstStation = stationsData.features[0];
        if (firstStation && firstStation.properties) {
          stationId = firstStation.properties.stationIdentifier;
        }
      }
    }

    return {
      success: true,
      gridId: props.gridId,
      gridX: props.gridX,
      gridY: props.gridY,
      forecastUrl: props.forecast,
      stationId,
      city,
      state,
    };
  }

  /**
   * Get period forecast (Today, Tonight, Tomorrow, etc.) from forecast URL
   */
  async getForecast(forecastUrl: string): Promise<ForecastResult> {
    const data = await this.get<{
      properties?: {
        generatedAt?: string;
        periods?: Array<{
          name?: string;
          isDaytime?: boolean;
          temperature?: number;
          temperatureUnit?: string;
          windSpeed?: string;
          windDirection?: string;
          shortForecast?: string;
          detailedForecast?: string;
        }>;
      };
    }>(forecastUrl);

    if (!data.properties?.periods) {
      return {
        success: false,
        error: "Invalid response from NWS forecast endpoint",
      };
    }

    const periods = data.properties.periods.map((p) => ({
      name: p.name ?? "Unknown",
      isDaytime: p.isDaytime ?? false,
      temperature: p.temperature ?? 0,
      temperatureUnit: p.temperatureUnit ?? "F",
      windSpeed: p.windSpeed ?? "N/A",
      windDirection: p.windDirection ?? "N/A",
      shortForecast: p.shortForecast ?? "",
      detailedForecast: p.detailedForecast ?? "",
    }));

    return {
      success: true,
      generatedAt: data.properties.generatedAt,
      periods,
    };
  }

  /**
   * Get current conditions from nearest observation station
   */
  async getCurrentConditions(stationId: string): Promise<CurrentConditions> {
    const url = `${NWS_BASE_URL}/stations/${stationId}/observations/latest`;
    const data = await this.get<{
      properties?: {
        temperature?: {
          value?: number;
          unitCode?: string;
        };
        relativeHumidity?: {
          value?: number;
        };
        windSpeed?: {
          value?: number;
        };
        windDirection?: {
          value?: number;
        };
        textDescription?: string;
        icon?: string;
        timestamp?: string;
      };
    }>(url);

    if (!data.properties) {
      return {
        success: false,
        error: "Invalid response from NWS observations endpoint",
      };
    }

    const props = data.properties;

    // Convert temperature from Celsius to Fahrenheit if needed
    let temperature = props.temperature?.value;
    let temperatureUnit = "F";
    if (temperature !== null && temperature !== undefined) {
      temperature = (temperature * 9) / 5 + 32; // C to F conversion
    }

    // Convert wind speed from m/s to mph if needed
    let windSpeed = props.windSpeed?.value;
    if (windSpeed !== null && windSpeed !== undefined) {
      windSpeed = windSpeed * 2.23694; // m/s to mph
    }

    return {
      success: true,
      temperature: temperature ?? undefined,
      temperatureUnit,
      humidity: props.relativeHumidity?.value ?? undefined,
      windSpeed: windSpeed ?? undefined,
      windDirection: props.windDirection?.value ?? undefined,
      textDescription: props.textDescription ?? undefined,
      icon: props.icon ?? undefined,
      timestamp: props.timestamp ?? undefined,
    };
  }

  /**
   * Get active weather alerts for a location
   */
  async getAlerts(lat: number, lon: number): Promise<AlertsResult> {
    const url = `${NWS_BASE_URL}/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`;
    const data = await this.get<{
      features?: Array<{
        properties?: {
          id?: string;
          event?: string;
          severity?: string;
          headline?: string;
          description?: string;
          instruction?: string;
          onset?: string;
          expires?: string;
        };
      }>;
    }>(url);

    if (!data.features) {
      return { success: true, alerts: [] };
    }

    const alerts = data.features
      .filter((f) => f.properties)
      .map((f) => ({
        id: f.properties!.id ?? "",
        event: f.properties!.event ?? "Unknown",
        severity: f.properties!.severity ?? "Unknown",
        headline: f.properties!.headline ?? "",
        description: f.properties!.description ?? "",
        instruction: f.properties!.instruction ?? "",
        onset: f.properties!.onset ?? "",
        expires: f.properties!.expires ?? "",
      }));

    return {
      success: true,
      alerts,
    };
  }

  /**
   * Private helper for GET requests with timeout and error handling
   */
  private async get<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "User-Agent": this.userAgent,
        Accept: "application/geo+json",
      };

      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { success: false, error: `HTTP ${res.status}: ${text}` } as T;
      }

      return (await res.json()) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message } as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
