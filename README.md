# PLCDoctor

Asistente de diagnóstico de averías para técnicos de mantenimiento industrial. Proyecto del Hackathon de Vibe Coding (Máster IA, Big School), desarrollado con Claude Code.

La app tiene tres zonas:

- **Chat**: el técnico describe la avería y el agente le asesora paso a paso.
- **Adjuntos**: documentación de la máquina (PDF, fotos y texto de PLC: `.scl`, `.xml`, `.st`, `.awl`, `.csv`, `.txt`) que el agente lee.
- **Descargables**: instrucciones de trabajo que genera el agente, descargables en PDF.

Funciona en escritorio y en móvil (pestañas abajo y botón de cámara).

## Cómo funciona

- Next.js (App Router). El agente corre en Claude Sonnet 5.5 a través de la API de Anthropic, con el prompt de sistema de `agente/prompt_agente.md`, búsqueda web puntual y respuesta en streaming.
- Los PDF y fotos se suben a la Files API de Anthropic; los textos de PLC se envían como documento de texto. Las fotos se reducen en el navegador antes de subirlas.
- El historial se envía en cada turno sin modificar los mensajes anteriores (con caché de prompt).
- Las instrucciones llegan entre etiquetas `<instruccion titulo="...">`; la app las quita del chat y genera el PDF en el navegador.
- La consulta se guarda en el navegador (localStorage). "Nueva consulta" la borra.

## Variables de entorno

| Variable | Obligatoria | Uso |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Sí | Clave de la API de Anthropic |
| `ACCESS_CODE` | No | Si se define, la app pide este código para entrar |

## Desarrollo

```bash
npm install
cp .env.example .env.local   # y rellena la clave
npm run dev
```

Despliegue en Vercel: importar el repositorio y definir las variables de entorno.
