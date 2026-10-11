/** Thin space (U+2009): groups thousands so figures can't be misread in Europe; the decimal point stays. */
export const THIN = " ";
export const num = (v: number, decimals = 0): string => {
  const [i, d] = Math.abs(v).toFixed(decimals).split(".");
  const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
  return (v < 0 ? "−" : "") + g + (d ? "." + d : "");
};
