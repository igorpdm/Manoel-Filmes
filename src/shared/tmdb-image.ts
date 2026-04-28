export type TmdbImageSize = "w300" | "w500" | "w1280";

const TMDB_IMAGE_ROOT = "https://image.tmdb.org/t/p";

export function buildTmdbImageUrl(imagePath: string | null | undefined, size: TmdbImageSize = "w500"): string | null {
    if (!imagePath) return null;
    return `${TMDB_IMAGE_ROOT}/${size}${imagePath}`;
}
