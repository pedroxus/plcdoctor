# PLCDoctor

Asistente de diagnóstico de averías para técnicos de mantenimiento industrial. El técnico le cuenta la avería desde el móvil o el PC, le sube la documentación de la máquina (esquemas, planos, programa del PLC, fotos) y PLCDoctor le asesora paso a paso como un compañero de staff técnico: qué comprobar, en qué orden, dónde medir y qué valor esperar. Cuando hay que intervenir, genera una instrucción de trabajo en PDF.

Proyecto del **Hackathon de Vibe Coding** (Máster en Inteligencia Artificial, Big School, edición 7), desarrollado al 100 % con **Claude Code**, del 11 al 19 de octubre de 2026.

- **App desplegada:** https://plcdoctor.vercel.app (pide un código de acceso de prueba, que se entrega al jurado en el formulario).
- Todos los datos de prueba son inventados (máquina ficticia CT-01, bomba de ejemplo B-200). No hay datos reales.

## Funcionalidades

1. **Chat con el agente de diagnóstico.** Respuestas en streaming, búsqueda web puntual (p. ej. el manual de un sensor) y razonamiento adaptativo. El agente no inventa datos de la máquina: cita el documento y la hoja de donde saca cada dato, separa lo que es dato, conocimiento general e hipótesis, y no repite comprobaciones que el técnico ya descartó.
2. **Adjuntos.** PDF, fotos (cámara, galería, pegar o arrastrar) y texto de PLC (`.scl`, `.xml`, `.st`, `.awl`, `.csv`, `.txt`). El agente los lee todos.
3. **Descargables.** Las instrucciones de trabajo del agente se convierten en PDF con el logo de PLCDoctor, con vista previa dentro del chat y descarga en el panel lateral.
4. **Histórico por similitud.** Si el técnico repite una consulta ya resuelta (aunque la diga con otras palabras) y con los mismos adjuntos, la app reutiliza la respuesta. Ante la duda, pregunta al agente.
5. **Dictado por voz.** El micro funciona como interruptor y el texto dictado cae en el cuadro para corregirlo antes de enviar.
6. **Pasos marcables.** Los pasos que propone el agente se pueden marcar como revisados o descartados (quedan tachados pero legibles) y el agente recibe lo marcado.
7. **Escritorio y móvil.** En escritorio, paneles laterales; en móvil, pestañas abajo y botón de cámara.

## Arquitectura

```
Navegador (Next.js / React)                     Servidor (rutas API de Next.js en Vercel)            Anthropic
─────────────────────────────                   ──────────────────────────────────────────           ─────────
Chat, Adjuntos, Descargables  ──/api/chat────►  Claude Sonnet 5.5 + prompt del agente  ──────────►  Messages API
Fotos reducidas a 1568 px     ──/api/upload──►  Files API (PDF y fotos, máx. 4 MB)     ──────────►  Files API
Histórico (localStorage)      ──/api/similar─►  Comparador de consultas (esfuerzo bajo)
PDF de instrucciones (jsPDF)                    /api/auth: comprueba ACCESS_CODE
Vista previa PDF (pdf.js)
Dictado (Web Speech API)
```

- **Next.js 16** (App Router) y **TypeScript**, desplegado en **Vercel**.
- **Agente:** Claude Sonnet 5.5 vía `@anthropic-ai/sdk`. El prompt de sistema está en [`agente/prompt_agente.md`](agente/prompt_agente.md) y se copia al código en cada build (`scripts/sync-prompt.mjs`).
- **Chat** (`app/api/chat/route.ts`): streaming NDJSON, herramienta de búsqueda web (máx. 3 por turno), caché de prompt. El historial se reenvía en cada turno sin modificar los mensajes anteriores.
- **Instrucciones de trabajo:** el agente las escribe entre etiquetas `<instruccion titulo="...">`; la app las quita del chat y genera el PDF en el navegador (`lib/pdf.ts`, `lib/instructions.ts`).
- **Histórico** (`lib/history.ts`, `app/api/similar/route.ts`): huella SHA-256 de cada adjunto; solo se comparan consultas con exactamente los mismos adjuntos.
- **Acceso:** si existe `ACCESS_CODE`, todas las rutas de la API exigen el código (`lib/server.ts`).
- La consulta abierta vive en la pestaña del navegador: recargar la conserva y "Nueva consulta" empieza limpio.

## Estructura

```
agente/prompt_agente.md   Prompt de sistema del agente (v5)
app/page.tsx              Interfaz: chat, adjuntos, descargables, dictado, histórico
app/PdfPreview.tsx        Vista previa del PDF dentro del chat
app/api/                  chat, upload, similar, auth
lib/                      PDF, instrucciones, histórico, cliente de Anthropic, logo
public/                   Logo SVG de PLCDoctor
scripts/sync-prompt.mjs   Copia el prompt del agente al código antes de compilar
```

## Variables de entorno

| Variable | Obligatoria | Uso |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Sí | Clave de la API de Anthropic |
| `ACCESS_CODE` | No | Si se define, la app pide este código para entrar |

Las claves solo se configuran en Vercel o en `.env.local`; nunca están en el repositorio.

## Ejecutar en local

```bash
npm install
cp .env.example .env.local   # y rellena la clave
npm run dev
```

Despliegue en Vercel: importar el repositorio y definir las variables de entorno.

## Cómo se hizo

Todo el código se generó con Claude Code a partir de prompts en lenguaje natural (muchos dictados por voz). El historial de prompts y la documentación técnica se entregan aparte, como Google Docs, en la carpeta del hackathon.
