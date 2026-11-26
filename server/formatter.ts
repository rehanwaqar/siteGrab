import prettier from 'prettier';

export async function formatCapturedCode(
  content: string,
  ext: 'html' | 'css' | 'js',
): Promise<string> {
  // Skip large minified bundles so formatting stays fast inside the job budget
  const limit = ext === 'html' ? 350 * 1024 : 180 * 1024;
  if (content.length > limit) {
    return content;
  }

  const parser = ext === 'html' ? 'html' : ext === 'css' ? 'css' : 'babel';

  try {
    return await prettier.format(content, {
      parser,
      printWidth: 100,
      tabWidth: 2,
      singleQuote: ext === 'js',
      semi: true,
    });
  } catch {
    // Keep original working code if Prettier encounters non-standard syntax
    return content;
  }
}
