import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

function copyAuthCookies(source: NextResponse, destination: NextResponse) {
  source.cookies.getAll().forEach(cookie => destination.cookies.set(cookie));
  for (const header of ['cache-control', 'expires', 'pragma']) {
    const value = source.headers.get(header);
    if (value) destination.headers.set(header, value);
  }
  return destination;
}

export async function proxy(request: NextRequest) {
  // The local preview has no business data and is never enabled in production.
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.next({ request });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(supabaseUrl, publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, cacheHeaders) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(cookie => response.cookies.set(cookie));
        Object.entries(cacheHeaders).forEach(([name, value]) => response.headers.set(name, value));
      }
    }
  });

  const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub) {
    const redirect = NextResponse.redirect(new URL('/', request.url));
    return copyAuthCookies(response, redirect);
  }

  return response;
}

export const config = {
  matcher: ['/dashboard/:path*']
};
