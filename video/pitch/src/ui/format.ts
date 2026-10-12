/** Thousands grouped with a thin space (U+2009), never a comma; the decimal point stays. */
export const num = (v: number, decimals = 0): string => {
  const [i, d] = Math.abs(v).toFixed(decimals).split(".");
  const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
  return (v < 0 ? "-" : "") + g + (d ? "." + d : "");
};
