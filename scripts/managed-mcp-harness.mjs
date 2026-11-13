import ts from 'typescript'

// Inspect the configuration factory, not comments or the desktop parent's env.
export function hasManagedMcpNodeMode(source, factoryName) {
  const file = ts.createSourceFile('mcp.ts', source, ts.ScriptTarget.Latest, true)
  const factory = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === factoryName)
  if (!factory?.body) return false
  const result = factory.body.statements.find(ts.isReturnStatement)?.expression
  if (!result || !ts.isObjectLiteralExpression(result)) return false
  const envProperty = result.properties.find(node => node.name?.getText(file) === 'env')
  let env = envProperty && ts.isPropertyAssignment(envProperty) ? envProperty.initializer : undefined
  if (envProperty && ts.isShorthandPropertyAssignment(envProperty)) {
    for (const statement of factory.body.statements) {
      if (!ts.isVariableStatement(statement)) continue
      env = statement.declarationList.declarations.find(node => node.name.getText(file) === 'env')?.initializer || env
    }
  }
  if (!env || !ts.isObjectLiteralExpression(env)) return false
  const index = env.properties.findLastIndex(node => node.name?.getText(file).replace(/^['"]|['"]$/g, '') === 'ELECTRON_RUN_AS_NODE')
  const flag = env.properties[index]
  return !!flag && ts.isPropertyAssignment(flag)
    && ts.isStringLiteral(flag.initializer) && flag.initializer.text === '1'
    && !env.properties.slice(index + 1).some(ts.isSpreadAssignment)
}
