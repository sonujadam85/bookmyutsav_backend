// Default setup & decoration checklist, imported from the handwritten list.
// verify: true marks items whose handwritten name needs confirmation.
export const DEFAULT_CHECKLIST = [
  { name: 'Home Decoration', category: 'Decoration' },
  { name: 'Haldi Theme', category: 'Themes' },
  { name: 'Mehndi Theme', category: 'Themes' },
  { name: 'Round Table', category: 'Seating & Furniture' },
  { name: 'Canopy / Mandap Canopy', category: 'Decoration', verify: true },
  { name: 'Sofa Sitting', category: 'Seating & Furniture' },
  { name: 'Chair Sitting', category: 'Seating & Furniture' },
  { name: 'Game Zone', category: 'Entertainment' },
  { name: 'Khana Patti', category: 'Catering' },
  { name: 'Sangeet Night', category: 'Themes' },
  { name: 'DJ Setup 4x4 + Ring', category: 'DJ & Sound' },
  { name: 'Main Gate Decoration', category: 'Decoration' },
  { name: 'VIP Lounge', category: 'Seating & Furniture' },
  { name: 'Selfie Point', category: 'Decoration' },
  { name: 'Phera Setup', category: 'Rituals' },
  { name: 'Wedding Stage', category: 'Stage' },
  { name: 'Sangeet Stage', category: 'Stage' },
  { name: 'Mini Stage', category: 'Stage' },
  { name: 'Barat Ghodi', category: 'Baraat' },
  { name: 'DJ on Wheel', category: 'Baraat' },
  { name: 'Band Baja', category: 'Baraat' },
  { name: 'Dhol Wale', category: 'Baraat' },
  { name: 'Wedding Varmala', category: 'Rituals' },
  { name: 'Wedding Entry', category: 'Entry' },
  { name: 'Sangeet Entry', category: 'Entry' },
  { name: 'Wedding Mayra', category: 'Rituals' },
  { name: 'Single Bride Entry', category: 'Entry' },
  { name: 'Single Groom Entry', category: 'Entry' },
  { name: 'U-Crate Gallery', category: 'Decoration', verify: true },
];

export const DEFAULT_EVENT_TYPES = [
  { name: 'Wedding', color: '#be185d' },
  { name: 'Engagement', color: '#7c3aed' },
  { name: 'Haldi', color: '#ca8a04' },
  { name: 'Mehndi', color: '#16a34a' },
  { name: 'Sangeet', color: '#2563eb' },
  { name: 'Reception', color: '#c2410c' },
  { name: 'Birthday', color: '#0891b2' },
  { name: 'Corporate', color: '#475569' },
  { name: 'Other', color: '#6b7280' },
];

// Stock items from the DJ Setup example. Stock and prices start at 0 - fill in your own figures.
export const DEFAULT_INVENTORY = [
  { name: 'Bass Speaker', category: 'DJ & Sound', unit: 'Piece' },
  { name: 'Top Speaker', category: 'DJ & Sound', unit: 'Piece' },
  { name: 'DJ Truss', category: 'DJ & Sound', unit: 'Set' },
  { name: 'LED Screen', category: 'LED Screen', unit: 'Feet' },
  { name: 'Cables', category: 'DJ & Sound', unit: 'Meter' },
  { name: 'Lighting', category: 'Lighting', unit: 'Set' },
];

export const EXPENSE_CATEGORIES = [
  'Decoration', 'DJ & Sound', 'LED Screen', 'Lighting', 'Stage', 'Furniture',
  'Food & Catering', 'Transportation', 'Labour', 'Band & Dhol', 'Other Expenses',
];

export const UNITS = ['Piece', 'Feet', 'Meter', 'Kg', 'Set', 'Pair', 'Box', 'Bundle', 'Litre', 'Roll', 'Sq Ft'];

// Default service price list, grouped by heading. [name, price, category, sort_order]
// Prices are editable under Services & Prices. New Photography / DJ items start at 0 until you set a price.
export const DECOR = 'Decoration & Setup';
export const PHOTO = 'Photography';
export const DJ = 'DJ & Sound';
export const DEFAULT_SERVICES = [
  ['Home Decoration', 3000], ['Haldi Theme', 4500], ['Mehndi Theme', 6200], ['Round Table', 9000],
  ['Canopy / Mandap Canopy', 8000], ['Sofa Sitting', 20000], ['Chair Sitting', 1000], ['Game Zone', 30000],
  ['Khana Patti', 50000], ['Sangeet Night', 150000], ['Main Gate Decoration', 10000],
  ['VIP Lounge', 10000], ['Selfie Point', 5000], ['Phera Setup', 5000], ['Wedding Stage', 30000],
  ['Sangeet Stage', 12000], ['Mini Stage', 45000], ['Barat Ghodi', 25000],
  ['Band Baja', 1200], ['Dhol Wale', 5000], ['Wedding Varmala', 45000], ['Wedding Entry', 20000],
  ['Sangeet Entry', 5000], ['Wedding Mayra', 5000], ['Single Bride Entry', 6000], ['Single Groom Entry', 48000],
].map(([n, p], i) => [n, p, DECOR, i + 1]).concat(
  ['Photo', 'Video', 'Pre-Wedding Shoot', 'Lagan', 'Bhat', 'Bandori', 'Reception', 'Haldi', 'Mehndi', 'Lagan-Tika']
    .map((n, i) => [n, 0, PHOTO, 101 + i]),
  [
    ['DJ Package 1 – 4 Top + 2 Bass, Single Truss', 0], ['DJ Package 2 – 8 Top + 4 Bass, Single Truss', 0],
    ['DJ Package 3 – 8 Top + 4 Bass, 4x4 Truss, Lanner', 0], ['DJ Package 4 – Pickup Set', 0],
    ['DJ on Wheel', 120000], ['DJ Setup 4x4 + Ring', 35000],
  ].map(([n, p], i) => [n, p, DJ, 201 + i]),
);
// Added to existing databases by the one-time "headings" update.
export const SERVICES_V2_NEW = new Set(DEFAULT_SERVICES.filter((d) => d[2] !== DECOR && !['DJ on Wheel', 'DJ Setup 4x4 + Ring'].includes(d[0])).map((d) => d[0]));
