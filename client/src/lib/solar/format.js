// Indian-locale number / currency formatting for the Solar Quotation module.
export const num = (v, d = 0) =>
  Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d });
export const inr = (v, d = 0) => '₹' + num(v, d);
