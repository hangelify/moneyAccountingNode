// Public API of the category module.
// Other modules import from here, never from files inside the module.
// The Nest module is not exported here: import it from ./<m>.module, so
// loading this barrel never pulls the module graph (and its cycles) in.

export type { RecentCategoryDto } from './dto/recent-categories.dto';
export { DEFAULT_CATEGORY_TREE } from './defaults';
export { CategoryBaseResponseDto } from './dto/category-base-response.dto';
export { CategoryResponseDto } from './dto/category-response.dto';
export { CategoryDefaultsService } from './category-defaults.service';
