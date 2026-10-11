import { BadRequestException, ForbiddenException } from '@nestjs/common';

export type ClientMode = 'web' | 'mobile';

export const CLIENT_TYPE_HEADER = 'x-client-type';

interface HeaderSource {
  get(name: string): string | undefined;
}

// Browsers always send Origin on POST and scripts cannot drop or forge it, so
// an XSS payload can neither opt into body tokens nor pass the origin check
// from another site. Native apps send no Origin and ask for mobile mode.
export function resolveClientMode(req: HeaderSource): ClientMode {
  const clientType = req.get(CLIENT_TYPE_HEADER);
  const origin = req.get('origin');

  if (clientType !== undefined) {
    if (clientType.toLowerCase() !== 'mobile') {
      throw new BadRequestException(
        `Unsupported ${CLIENT_TYPE_HEADER} header; the only accepted value is "mobile"`,
      );
    }
    if (origin !== undefined) {
      throw new ForbiddenException(
        'Mobile client mode is not available to browsers',
      );
    }
    return 'mobile';
  }

  if (origin !== undefined && isAllowedWebOrigin(origin, req.get('host'))) {
    return 'web';
  }
  throw new ForbiddenException('Request origin is not allowed');
}

// The frontend origin, or the API's own origin (Swagger UI served at /api).
function isAllowedWebOrigin(origin: string, host: string | undefined): boolean {
  const parsed = parseOrigin(origin);
  if (!parsed) {
    return false;
  }
  const frontend = parseOrigin(
    process.env.FRONTEND_URL || 'http://localhost:5173',
  );
  return parsed.origin === frontend?.origin || parsed.host === host;
}

function parseOrigin(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.origin === 'null' ? undefined : url;
  } catch {
    return undefined;
  }
}
