// Copia el prompt del agente (agente/prompt_agente.md) a un módulo TS para el servidor.
import { readFileSync, writeFileSync } from "node:fs";
const md = readFileSync(new URL("../agente/prompt_agente.md", import.meta.url), "utf8");
writeFileSync(
  new URL("../lib/prompt.generated.ts", import.meta.url),
  `// Generado por scripts/sync-prompt.mjs. No editar a mano.\nexport const SYSTEM_PROMPT = ${JSON.stringify(md)};\n`,
);
console.log("Prompt del agente sincronizado (" + md.length + " caracteres)");
