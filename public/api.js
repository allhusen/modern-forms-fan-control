export async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    signal: AbortSignal.timeout(35000),
    cache: 'no-store',
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'The controller could not complete this request.');
    error.data = data;
    throw error;
  }
  return data;
}
