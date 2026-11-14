// Public API of the category module.
// Other modules import from here, never from files inside the module.
// Order matters: leaf files first, the Nest module last, so a module that
// imports this barrel back during loading still finds the leaf exports.

export type { RecentCategoryDto } from './dto/recent-categories.dto';
export { DEFAULT_CATEGORY_TREE } from './defaults';
export { CategoryBaseResponseDto } from './dto/category-base-response.dto';
export { CategoryResponseDto } from './dto/category-response.dto';
export { CategoryDefaultsService } from './category-defaults.service';
export { CategoryModule } from './category.module';
