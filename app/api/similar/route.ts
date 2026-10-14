import { checkAccess, getClient, MODEL } from "@/lib/server";

export const runtime = "nodejs";

const SYSTEM = `Comparas consultas de técnicos de mantenimiento industrial para reutilizar respuestas ya dadas.
Todas las consultas se hicieron con la misma documentación adjunta. Decide si la consulta nueva pide exactamente lo mismo que alguna anterior: misma máquina o componente, mismo síntoma o avería, mismas comprobaciones ya hechas y misma petición, aunque esté dicho con otras palabras.
Si cambia cualquier dato técnico (código de alarma, componente, síntoma, lo ya revisado) o tienes la más mínima duda, no es equivalente.
Responde con el número de la consulta equivalente, o -1 si ninguna lo es.`;

// Busca en el histórico una consulta equivalente a la nueva. Ante la duda devuelve null
// y la app consulta al agente.
export async function POST(req: Request) {
  const denied = checkAccess(req);
  if (denied) return denied;
  try {
    const { question, candidates } = (await req.json()) as { question: string; candidates: string[] };
    if (!question || !Array.isArray(candidates) || candidates.length === 0) return Response.json({ match: null });

    const list = candidates.map((c, i) => `<consulta numero="${i}">\n${c}\n</consulta>`).join("\n");
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { match: { type: "integer" } },
            required: ["match"],
            additionalProperties: false,
          },
        },
      },
      messages: [
        {
          role: "user",
          content: `Consultas anteriores:\n${list}\n\nConsulta nueva:\n<nueva>\n${question}\n</nueva>`,
        },
      ],
    });

    if (response.stop_reason !== "end_turn") return Response.json({ match: null });
    const text = response.content.find((b) => b.type === "text");
    const match = text && text.type === "text" ? (JSON.parse(text.text) as { match: number }).match : -1;
    return Response.json({ match: Number.isInteger(match) && match >= 0 && match < candidates.length ? match : null });
  } catch (err) {
    console.error(err);
    return Response.json({ match: null });
  }
}
