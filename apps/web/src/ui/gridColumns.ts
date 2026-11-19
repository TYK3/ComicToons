/** Studio panel grid column rule (S6 #10): up to 4 panels get one column per panel; past that,
 * 4 columns tile evenly (n%4 is 0 or 3) and 3 columns otherwise. */
export function gridColumns(n: number): number {
  if (n <= 4) return n;
  return n % 4 === 0 || n % 4 === 3 ? 4 : 3;
}
