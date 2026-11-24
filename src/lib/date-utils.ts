/** `timestamp` in seconds. */
export function formatUnixTimestamp(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  
  if (isToday(date)) {
    return formatTime(date);
  }
  
  if (isYesterday(date)) {
    return `Yesterday, ${formatTime(date)}`;
  }
  
  if (isWithinWeek(date)) {
    return `${getDayName(date)}, ${formatTime(date)}`;
  }
  
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric' 
    });
  }
  
  return date.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric',
    year: 'numeric'
  });
}

export function formatISOTimestamp(isoString: string): string {
  const date = new Date(isoString);
  return formatUnixTimestamp(Math.floor(date.getTime() / 1000));
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

export function getFirstLine(text: string): string {
  const lines = text.split('\n');
  return lines[0] || '';
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { 
    hour: 'numeric', 
    minute: '2-digit',
    hour12: true 
  });
}

function isToday(date: Date): boolean {
  const today = new Date();
  return date.toDateString() === today.toDateString();
}

function isYesterday(date: Date): boolean {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return date.toDateString() === yesterday.toDateString();
}

function isWithinWeek(date: Date): boolean {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  return date > weekAgo;
}

function getDayName(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'long' });
}

/** `timestamp` in milliseconds. */
export function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);
  
  if (years > 0) {
    return years === 1 ? '1 year ago' : `${years} years ago`;
  }
  if (months > 0) {
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }
  if (weeks > 0) {
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  }
  if (days > 0) {
    return days === 1 ? '1 day ago' : `${days} days ago`;
  }
  if (hours > 0) {
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  if (minutes > 0) {
    return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  }
  if (seconds > 0) {
    return seconds === 1 ? '1 second ago' : `${seconds} seconds ago`;
  }
  
  return 'just now';
} 
