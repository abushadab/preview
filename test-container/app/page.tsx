export default function TestPage() {
  return (
    <div>
      <h1>🚀 Test Container Working!</h1>
      <p>Domain: test.hellyo.io</p>
      <p>Port: {process.env.PORT || '3000'}</p>
      <p>Time: {new Date().toISOString()}</p>
    </div>
  );
}