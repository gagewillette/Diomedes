// Greeting lines for the home page. Each entry is a template that receives the
// user's first name; a few ignore it entirely so the header doesn't feel canned.
const ANY_TIME = [
  (name) => `👋 Welcome back, ${name}`,
  (name) => `✨ What are we working on, ${name}?`,
  () => '📝 Ready when you are',
  (name) => `🚀 Let's pick up where you left off, ${name}`,
  () => '🧠 What should we write down today?',
  (name) => `👀 Good to see you, ${name}`,
  () => '📚 Your knowledge base awaits',
  (name) => `⚡ Back at it, ${name}?`,
  () => '🔍 Looking for something?',
  (name) => `🎯 Nice to have you here, ${name}`,
];

const MORNING = [
  (name) => `🌅 Good morning, ${name}`,
  () => '☕ Morning — what’s first today?',
  (name) => `🌤️ Fresh start, ${name}`,
];

const AFTERNOON = [
  (name) => `🌞 Good afternoon, ${name}`,
  () => '🍃 Afternoon — what’s next?',
  (name) => `📈 Halfway there, ${name}`,
];

const EVENING = [
  (name) => `🌆 Good evening, ${name}`,
  () => '🌙 Winding down, or just getting started?',
  (name) => `🕯️ Evening, ${name}`,
];

const NIGHT = [
  (name) => `🌚 Burning the midnight oil, ${name}?`,
  () => '🌌 Still up? Let’s make it count',
  (name) => `😴 Late night, ${name}`,
];

// Buckets keep the time-based lines honest — a "good morning" at 11pm reads badly.
export function timeBucket(hour) {
  if (hour < 5) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 22) return 'evening';
  return 'night';
}

const BY_BUCKET = { morning: MORNING, afternoon: AFTERNOON, evening: EVENING, night: NIGHT };

export function greetingsFor(bucket) {
  return [...(BY_BUCKET[bucket] || []), ...ANY_TIME];
}

export function pickGreeting(name, date = new Date()) {
  const first = (name || '').split(' ')[0] || 'there';
  const options = greetingsFor(timeBucket(date.getHours()));
  return options[Math.floor(Math.random() * options.length)](first);
}
