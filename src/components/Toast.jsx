export default function Toast({ message, type }) {
  const bg = type === 'error' ? 'bg-red-600' : 'bg-sky-600';
  return (
    <div className={`fixed bottom-4 right-4 ${bg} text-white px-4 py-2 rounded-lg shadow-lg text-sm z-50 animate-fade-in`}>
      {message}
    </div>
  );
}
