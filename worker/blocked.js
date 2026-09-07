export default {
  fetch() {
    return new Response('Cloudflare Access setup is in progress.', {
      status: 403,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  }
};
