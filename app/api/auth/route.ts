import { checkAccess } from "@/lib/server";

export async function GET() {
  return Response.json({ required: Boolean(process.env.ACCESS_CODE) });
}

export async function POST(req: Request) {
  return checkAccess(req) ?? Response.json({ ok: true });
}
