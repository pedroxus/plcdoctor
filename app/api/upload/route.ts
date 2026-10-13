import { toFile } from "@anthropic-ai/sdk";
import { checkAccess, getClient } from "@/lib/server";

export const runtime = "nodejs";

const ALLOWED = ["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"];

// Sube un PDF o una imagen a la Files API de Anthropic y devuelve su file_id.
export async function POST(req: Request) {
  const denied = checkAccess(req);
  if (denied) return denied;
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "No se ha recibido ningún archivo" }, { status: 400 });
    }
    if (!ALLOWED.includes(file.type)) {
      return Response.json({ error: `Formato no admitido: ${file.type || file.name}` }, { status: 400 });
    }
    const uploaded = await getClient().files.upload({
      file: await toFile(Buffer.from(await file.arrayBuffer()), file.name, { type: file.type }),
    });
    return Response.json({ id: uploaded.id });
  } catch (err) {
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : "Error al subir el archivo" }, { status: 500 });
  }
}
