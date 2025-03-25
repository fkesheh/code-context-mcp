/**
 * Convert a glob pattern to an SQL LIKE pattern
 */
export function globToSqlPattern(pattern: string): string {
  // Handle ** (any depth of directories)
  let sqlPattern = pattern.replace(/\*\*/g, '%');
  
  // Handle * (any characters within a directory)
  sqlPattern = sqlPattern.replace(/\*/g, '%');
  
  return sqlPattern;
}

/**
 * Create SQL WHERE conditions for file pattern filtering using numbered parameters
 * for better SQLite compatibility
 */
export function createFilePatternCondition(
  includePatterns: string[] | undefined,
  excludePatterns: string[] | undefined
): string {
  let conditions = '';
  
  // Include patterns (files must match at least one pattern)
  if (includePatterns && includePatterns.length > 0) {
    const includeConditions = includePatterns.map(pattern => {
      const sqlPattern = globToSqlPattern(pattern);
      return `f.path LIKE '${sqlPattern}'`;
    });
    conditions += ` AND (${includeConditions.join(' OR ')})`;
  }
  
  // Exclude patterns (files must not match any pattern)
  if (excludePatterns && excludePatterns.length > 0) {
    const excludeConditions = excludePatterns.map(pattern => {
      const sqlPattern = globToSqlPattern(pattern);
      return `f.path NOT LIKE '${sqlPattern}'`;
    });
    conditions += ` AND (${excludeConditions.join(' AND ')})`;
  }
  
  return conditions;
}
