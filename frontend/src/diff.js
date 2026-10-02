/** Line diff by longest common subsequence. Rows are { type: 'same' | 'add' | 'del', text }. */
export function diffLines(a, b) {
  const x = a.split('\n'); const y = b.split('\n');
  const n = x.length; const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows = []; let i = 0; let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { rows.push({ type: 'same', text: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) rows.push({ type: 'del', text: x[i++] });
    else rows.push({ type: 'add', text: y[j++] });
  }
  while (i < n) rows.push({ type: 'del', text: x[i++] });
  while (j < m) rows.push({ type: 'add', text: y[j++] });
  return rows;
}
