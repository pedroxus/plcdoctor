import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-sonnet-5-5";

// Cabecera de la Files API: se envía en la subida y en cada mensaje que referencia un archivo.
export const FILES_BETA = "files-api-2025-04-14";

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Falta la variable de entorno ANTHROPIC_API_KEY");
  }
  client ??= new Anthropic();
  return client;
}

// Si ACCESS_CODE está definido, todas las peticiones a la API deben traerlo.
export function checkAccess(req: Request): Response | null {
  const code = process.env.ACCESS_CODE;
  if (!code) return null;
  if (req.headers.get("x-access-code") === code) return null;
  return Response.json({ error: "Código de acceso incorrecto" }, { status: 401 });
}
