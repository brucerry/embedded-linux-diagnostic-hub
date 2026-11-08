import assert from 'node:assert/strict';
import ts from 'typescript';

// Parse source as data only. Match syntax nodes, never comments or string contents.
export function sourceTree(source: string) {
    const tree = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
    assert.equal((tree as any).parseDiagnostics.length, 0, 'Expected valid source syntax.');
    return tree;
}

export function sourceNodes<T extends ts.Node>(
    tree: ts.Node,
    guard: (node: ts.Node) => node is T,
): T[] {
    const found: T[] = [];
    const visit = (node: ts.Node) => {
        if (guard(node)) found.push(node);
        ts.forEachChild(node, visit);
    };
    visit(tree);
    return found;
}

// Scanner boundaries preserve literal values and operators while ignoring layout
// and optional trailing commas. Whitespace inside strings is never discarded.
function tokens(source: string) {
    const scanner = ts.createScanner(
        ts.ScriptTarget.Latest,
        true,
        ts.LanguageVariant.Standard,
        source,
    );
    const result: [ts.SyntaxKind, string][] = [];
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan())
        result.push([kind, scanner.getTokenText()]);
    return result.filter(
        ([kind], index) =>
            kind !== ts.SyntaxKind.CommaToken ||
            ![
                ts.SyntaxKind.CloseParenToken,
                ts.SyntaxKind.CloseBracketToken,
                ts.SyntaxKind.CloseBraceToken,
            ].includes(result[index + 1]?.[0]) ||
            // Array elisions carry meaning; a comma after '[' or ',' is not optional.
            (result[index + 1]?.[0] === ts.SyntaxKind.CloseBracketToken &&
                [ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.CommaToken].includes(
                    result[index - 1]?.[0],
                )),
    );
}

export function sameSource(node: ts.Node, expected: string) {
    return JSON.stringify(tokens(node.getText())) === JSON.stringify(tokens(expected));
}

export function sourceCall(tree: ts.Node, callee: string, args?: string[], prefix = false) {
    const node = sourceNodes(tree, ts.isCallExpression).find(
        (call) =>
            sameSource(call.expression, callee) &&
            (args === undefined ||
                ((prefix
                    ? call.arguments.length >= args.length
                    : call.arguments.length === args.length) &&
                    args.every((arg, index) => sameSource(call.arguments[index], arg)))),
    );
    assert.ok(node, 'Missing call: ' + callee + '(' + (args?.join(', ') ?? '...') + ')');
    return node;
}

export function sourceVariableCall(tree: ts.Node, name: string, callee: string) {
    const node = sourceNodes(tree, ts.isVariableDeclaration).find(
        (declaration) =>
            sameSource(declaration.name, name) &&
            ts.isVariableDeclarationList(declaration.parent) &&
            Boolean(declaration.parent.flags & ts.NodeFlags.Const) &&
            declaration.initializer &&
            ts.isCallExpression(declaration.initializer) &&
            sameSource(declaration.initializer.expression, callee),
    );
    assert.ok(node, 'Missing variable call: ' + name + ' = ' + callee + '(...)');
    return node;
}

export function sourceAssignmentCall(tree: ts.Node, name: string, callee: string) {
    const node = sourceNodes(tree, ts.isBinaryExpression).find(
        (assignment) =>
            assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            sameSource(assignment.left, name) &&
            ts.isCallExpression(assignment.right) &&
            sameSource(assignment.right.expression, callee),
    );
    assert.ok(node, 'Missing assignment call: ' + name + ' = ' + callee + '(...)');
    return node;
}

export function sourceProperty(tree: ts.Node, name: string, value: string) {
    const properties = ts.isObjectLiteralExpression(tree)
        ? tree.properties.filter(ts.isPropertyAssignment)
        : sourceNodes(tree, ts.isPropertyAssignment);
    const node = properties.find(
        (property) => sameSource(property.name, name) && sameSource(property.initializer, value),
    );
    assert.ok(node, 'Missing property binding: ' + name + ': ' + value);
    return node;
}

export function sourceBefore(first: ts.Node, second: ts.Node) {
    assert.ok(first.getStart() < second.getStart(), 'Expected source guard before effect.');
}

// Rename a call in mutation controls without breaking syntax or changing layout.
export function withoutSourceCall(source: string, call: ts.CallExpression) {
    return (
        source.slice(0, call.expression.getStart()) +
        '__removed_guard__' +
        source.slice(call.expression.end)
    );
}

export { ts };
