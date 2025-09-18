export async function GET() {
  return Response.json({ status: 'ok', message: 'Test container is healthy!' });
}