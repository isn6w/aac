import { isIP } from 'node:net';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = request.headers.get('x-real-ip')?.trim();
  const candidate = forwardedFor || realIp || (process.env.NODE_ENV === 'development' ? '127.0.0.1' : '');
  const ip = isIP(candidate) ? candidate : 'Indisponível';

  return Response.json({ ip }, { headers: { 'Cache-Control': 'no-store' } });
}