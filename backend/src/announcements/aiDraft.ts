export interface AnnouncementDraftSuggestion {
  title: string;
  body: string;
  pushPreview: string;
}

export type AiDraftErrorKind = "unavailable" | "provider_error" | "invalid_output";

export class AiDraftError extends Error {
  constructor(readonly kind: AiDraftErrorKind) {
    super(kind);
    this.name = "AiDraftError";
  }
}

export interface AiDraftProvider {
  generate(notes: string): Promise<unknown>;
}

export type AiDraftGenerator = (notes: string) => Promise<AnnouncementDraftSuggestion>;

export interface AiProviderConfig {
  apiKey?: string;
  apiUrl?: string;
  model?: string;
}

type FetchImplementation = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateAnnouncementDraft(value: unknown): AnnouncementDraftSuggestion {
  if (!isRecord(value)) {
    throw new AiDraftError("invalid_output");
  }

  const { title, body, pushPreview } = value;
  if (
    typeof title !== "string" ||
    title.trim().length === 0 ||
    title.trim().length > 200 ||
    typeof body !== "string" ||
    body.trim().length === 0 ||
    body.trim().length > 20_000 ||
    typeof pushPreview !== "string" ||
    pushPreview.trim().length === 0 ||
    pushPreview.trim().length > 120 ||
    Object.keys(value).some((key) => !["title", "body", "pushPreview"].includes(key))
  ) {
    throw new AiDraftError("invalid_output");
  }

  return {
    title: title.trim(),
    body: body.trim(),
    pushPreview: pushPreview.trim(),
  };
}

export function createAiDraftGenerator(provider: AiDraftProvider): AiDraftGenerator {
  return async (notes) => validateAnnouncementDraft(await provider.generate(notes));
}

export function createOpenAiCompatibleDraftProvider(
  config: AiProviderConfig = {
    apiKey: process.env.AI_API_KEY,
    apiUrl: process.env.AI_API_URL,
    model: process.env.AI_MODEL,
  },
  fetchImplementation: FetchImplementation = fetch,
): AiDraftProvider {
  return {
    async generate(notes: string): Promise<unknown> {
      const apiKey = config.apiKey?.trim();
      if (!apiKey) {
        throw new AiDraftError("unavailable");
      }

      const apiUrl = config.apiUrl?.trim() || "https://api.openai.com/v1/chat/completions";
      const model = config.model?.trim() || "gpt-4o-mini";
      let response: Response;
      try {
        response = await fetchImplementation(apiUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: 4_096,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content:
                  "Turn leadership notes into a clear, factual union-local announcement draft. " +
                  "Do not invent dates, locations, promises, or facts absent from the notes. " +
                  "Return only a JSON object with string fields title, body, and pushPreview. " +
                  "Keep title at most 200 characters, body at most 20000 characters, and pushPreview at most 120 characters. " +
                  "This is draft text only: never choose recipients, approve, or send an announcement.",
              },
              { role: "user", content: notes },
            ],
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new AiDraftError("provider_error");
      }

      if (!response.ok) {
        throw new AiDraftError("provider_error");
      }

      let result: unknown;
      try {
        result = await response.json();
      } catch {
        throw new AiDraftError("invalid_output");
      }

      if (!isRecord(result) || !Array.isArray(result.choices) || !isRecord(result.choices[0])) {
        throw new AiDraftError("invalid_output");
      }
      const message = result.choices[0].message;
      if (!isRecord(message) || typeof message.content !== "string") {
        throw new AiDraftError("invalid_output");
      }

      try {
        return JSON.parse(message.content) as unknown;
      } catch {
        throw new AiDraftError("invalid_output");
      }
    },
  };
}

export const generateAnnouncementDraft = createAiDraftGenerator(
  createOpenAiCompatibleDraftProvider(),
);
