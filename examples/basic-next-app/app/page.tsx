export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="z-10 max-w-5xl w-full items-center justify-center font-mono text-sm">
        <h1 className="text-4xl font-bold mb-4">Hello from Sandbox!</h1>
        <p className="text-lg mb-4">
          This is a basic Next.js application running in a sandbox environment.
        </p>
        <p className="text-gray-500">
          Preview ID: {process.env.NEXT_PUBLIC_SANDBOX_ID || 'unknown'}
        </p>
      </div>
    </main>
  );
}