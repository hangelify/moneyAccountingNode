export interface DefaultSubCategory {
  name: string;
}

export interface DefaultCategoryNode {
  name: string;
  subCategories: DefaultSubCategory[];
}

const nodes = (names: string[]): DefaultSubCategory[] =>
  names.map((n) => ({ name: n }));

export const DEFAULT_CATEGORY_TREE: readonly DefaultCategoryNode[] = [
  // Groceries
  {
    name: 'Bread',
    subCategories: nodes([
      'pita',
      'bun',
      'galettes',
      'baguette',
      'rolls',
      'pastries',
    ]),
  },
  {
    name: 'Dairy',
    subCategories: nodes([
      'milk',
      'cheese',
      'yogurt',
      'butter',
      'cream',
      'sour cream',
      'cottage cheese',
      'eggs',
    ]),
  },
  {
    name: 'Fruits',
    subCategories: nodes([
      'apples',
      'bananas',
      'citrus',
      'berries',
      'grapes',
      'stone fruits',
      'dried fruits',
    ]),
  },
  {
    name: 'Vegetables',
    subCategories: nodes([
      'tomatoes',
      'potatoes',
      'onions',
      'carrots',
      'cabbage',
      'leafy greens',
      'cucumbers',
      'peppers',
      'mushrooms',
    ]),
  },
  {
    name: 'Meat & Fish',
    subCategories: nodes([
      'beef',
      'chicken',
      'pork',
      'fish',
      'seafood',
      'sausages',
      'deli',
    ]),
  },
  {
    name: 'Pantry',
    subCategories: nodes([
      'rice',
      'pasta',
      'grains',
      'cereals',
      'flour',
      'sugar',
      'oil',
      'spices',
      'sauces',
      'honey & jam',
      'canned goods',
    ]),
  },
  {
    name: 'Ready Meals',
    subCategories: nodes(['salads', 'hot meals', 'sushi', 'sandwiches']),
  },
  {
    name: 'Beverages',
    subCategories: nodes([
      'water',
      'soft drinks',
      'juice',
      'coffee',
      'tea',
      'beer',
      'wine',
      'spirits',
    ]),
  },
  {
    name: 'Snacks & Sweets',
    subCategories: nodes([
      'chips',
      'cookies',
      'chocolate',
      'candy',
      'nuts',
      'cakes',
    ]),
  },
  {
    name: 'Frozen',
    subCategories: nodes([
      'frozen meals',
      'dumplings',
      'ice cream',
      'frozen vegetables',
      'frozen fish',
    ]),
  },
  {
    name: 'Eating Out',
    subCategories: nodes([
      'restaurant',
      'cafe',
      'fast food',
      'delivery',
      'coffee to go',
    ]),
  },
  // Home & personal care
  {
    name: 'Personal Hygiene',
    subCategories: nodes([
      'shampoo',
      'shower gel',
      'soap',
      'toothpaste',
      'toothbrushes',
      'deodorant',
      'shaving',
      'feminine hygiene',
      'cotton pads',
      'wet wipes',
    ]),
  },
  {
    name: 'Cosmetics & Skin Care',
    subCategories: nodes([
      'face care',
      'body care',
      'hair care',
      'makeup',
      'sun care',
      'perfume',
    ]),
  },
  {
    name: 'Household Chemicals',
    subCategories: nodes([
      'dish soap',
      'dishwasher tablets',
      'laundry detergent',
      'fabric softener',
      'stain remover',
      'surface cleaner',
      'toilet cleaner',
      'bleach',
      'air freshener',
    ]),
  },
  {
    name: 'Household & Domestic Goods',
    subCategories: nodes([
      'paper towels',
      'toilet paper',
      'napkins',
      'trash bags',
      'sponges & cloths',
      'foil & cling film',
      'light bulbs',
      'batteries',
      'cleaning tools',
    ]),
  },
  {
    name: 'Shopping Bags',
    subCategories: nodes(['plastic bag', 'paper bag', 'reusable bag']),
  },
  {
    name: 'Home & Kitchen',
    subCategories: nodes([
      'cookware',
      'tableware',
      'kitchen utensils',
      'storage containers',
      'towels',
      'bedding',
      'decor',
      'small appliances',
    ]),
  },
  {
    name: 'Health & Pharmacy',
    subCategories: nodes([
      'medicine',
      'vitamins',
      'first aid',
      'medical devices',
    ]),
  },
  {
    name: 'Cat Supplies',
    subCategories: nodes([
      'dry food',
      'wet food',
      'treats',
      'litter',
      'toys',
      'accessories',
      'flea & worm treatment',
      'vet care',
    ]),
  },
  // Shopping
  {
    name: 'Clothing & Shoes',
    subCategories: nodes([
      'tops',
      'bottoms',
      'dresses',
      'outerwear',
      'underwear & socks',
      'sleepwear',
      'shoes',
      'accessories',
      'kids clothing',
    ]),
  },
  {
    name: 'Sports & Outdoor',
    subCategories: nodes([
      'sportswear',
      'sports shoes',
      'fitness equipment',
      'cycling',
      'swimming',
      'camping & hiking',
      'team sports',
      'sports nutrition',
    ]),
  },
  {
    name: 'Electronics',
    subCategories: nodes([
      'cables & chargers',
      'headphones',
      'phone accessories',
      'small devices',
    ]),
  },
  {
    name: 'Stationery & Office',
    subCategories: nodes([
      'paper',
      'pens & pencils',
      'notebooks',
      'printing',
      'gift wrap',
    ]),
  },
  {
    name: 'Gifts & Flowers',
    subCategories: nodes([
      'flowers',
      'gifts',
      'greeting cards',
      'party supplies',
    ]),
  },
];
