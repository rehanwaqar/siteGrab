import prettier from 'prettier';

export async function formatCapturedCode(
  content: string,
  ext: 'html' | 'css' | 'js',
): Promise<string> {
  // Skip massive bundled JS files > 1.5 MB to stay well inside the 60s job budget
  if (content.length > 1.5 * 1024 * 1024) {
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
