import { Router } from 'express';
import { buildOpenApi } from '../docs/openapi';

/**
 *   GET /api/docs               – interactive Swagger UI
 *   GET /api/docs/openapi.json  – the OpenAPI document (import into Postman, codegen, etc.)
 *
 * Public on purpose: it describes the API, it does not grant access. The UI is loaded from a
 * pinned CDN build, so the CSP is relaxed for this one page only.
 */
export const docsRouter = Router();

const SWAGGER_UI = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14';
let spec: ReturnType<typeof buildOpenApi> | undefined;

docsRouter.get('/openapi.json', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300').json((spec ??= buildOpenApi()));
});

docsRouter.get('/', (_req, res) => {
  res.set(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'self' 'unsafe-inline' ${SWAGGER_UI.split('/npm')[0]}; style-src 'self' 'unsafe-inline' ${SWAGGER_UI.split('/npm')[0]}; img-src 'self' data: https:; connect-src 'self'; font-src 'self' data:`,
  )
    .type('html')
    .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SMS Gateway API</title>
  <link rel="stylesheet" href="${SWAGGER_UI}/swagger-ui.css" />
</head>
<body>
  <div id="ui"></div>
  <script src="${SWAGGER_UI}/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({ url: '/api/docs/openapi.json', dom_id: '#ui', deepLinking: true, persistAuthorization: false, tryItOutEnabled: false });
  </script>
</body>
</html>`);
});
