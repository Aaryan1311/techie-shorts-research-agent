let tokensUsedToday = 0;
let lastResetDate = new Date().toDateString();
const DAILY_TOKEN_BUDGET = 1_200_000; // 3 keys × 400K each

export function trackTokens(used: number): void {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    tokensUsedToday = 0;
    lastResetDate = today;
  }
  tokensUsedToday += used;
}

export function hasBudget(): boolean {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    tokensUsedToday = 0;
    lastResetDate = today;
  }
  return tokensUsedToday < DAILY_TOKEN_BUDGET;
}

export function getBudgetStatus(): string {
  return `${tokensUsedToday.toLocaleString()} / ${DAILY_TOKEN_BUDGET.toLocaleString()} tokens used today`;
}
