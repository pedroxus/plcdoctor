import type Anthropic from "@anthropic-ai/sdk";
import { checkAccess, FILES_BETA, getClient, MODEL } from "@/lib/server";
import { SYSTEM_PROMPT } from "@/lib/prompt.generated";

export const runtime = "nodejs";
export const maxDuration = 300;

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

// El historial es "solo añadir": el cliente guarda los bloques del asistente tal
// cual llegan (incluidos los de razonamiento) y los reenvía sin modificar.
export async function POST(req: Request) {
  const denied = checkAccess(req);
  if (denied) return denied;

  const { messages } = (await req.json()) as { messages: MessageParam[] };
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "Conversación vacía" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const send = (event: object) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        const client = getClient();
        const history: MessageParam[] = [...messages];
        const produced: ContentBlock[][] = [];

        // Un turno puede pausarse (pause_turn) mientras usa la búsqueda web; se continúa hasta el final.
        for (let round = 0; round < 4; round++) {
          const stream = client.beta.messages.stream({
            model: MODEL,
            max_tokens: 32000,
            system: SYSTEM_PROMPT,
            messages: history,
            thinking: { type: "adaptive" },
            output_config: { effort: "medium" },
            cache_control: { type: "ephemeral" },
            tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
            betas: ["server-side-fallback-2026-07-01", FILES_BETA],
            fallbacks: "default",
          });

          for await (const event of stream) {
            if (event.type === "content_block_start" && event.content_block.type === "server_tool_use") {
              send({ t: "status", d: "Buscando en internet…" });
            } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              send({ t: "text", d: event.delta.text });
            }
          }

          const message = await stream.finalMessage();
          produced.push(message.content);
          history.push({ role: "assistant", content: message.content as MessageParam["content"] });

          if (message.stop_reason === "refusal") {
            send({ t: "text", d: "\n\nNo puedo ayudar con esta petición." });
          }
          if (message.stop_reason !== "pause_turn") break;
        }

        send({ t: "done", turns: produced });
      } catch (err) {
        console.error(err);
        send({ t: "error", d: err instanceof Error ? err.message : "Error desconocido" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
