// Indian number-to-words (Lakhs / Crores). Used on salary slips and POs to
// print the cheque-style amount-in-words footer.
//   8500    → "Eight Thousand Five Hundred"
//   85000   → "Eighty Five Thousand"
//   125000  → "One Lakh Twenty Five Thousand"
//   8500000 → "Eighty Five Lakh"

const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine',
  'Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];

function twoDigit(n) {
  if (n < 20) return ones[n];
  return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
}

function threeDigit(n) {
  let str = '';
  if (n >= 100) {
    str += ones[Math.floor(n / 100)] + ' Hundred';
    n %= 100;
    if (n) str += ' ';
  }
  if (n) str += twoDigit(n);
  return str;
}

export function numberToWords(num) {
  num = Math.round(num || 0);
  if (num === 0) return 'Zero';
  if (num < 0) return 'Minus ' + numberToWords(-num);

  let str = '';
  const crore = Math.floor(num / 10000000);
  num %= 10000000;
  const lakh = Math.floor(num / 100000);
  num %= 100000;
  const thousand = Math.floor(num / 1000);
  num %= 1000;
  const rest = num;

  if (crore) str += twoDigit(crore) + ' Crore ';
  if (lakh) str += twoDigit(lakh) + ' Lakh ';
  if (thousand) str += twoDigit(thousand) + ' Thousand ';
  if (rest) str += threeDigit(rest);

  return str.trim();
}

export function rupeesInWords(num) {
  return numberToWords(num) + ' Only';
}
