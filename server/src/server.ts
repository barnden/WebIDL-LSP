/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult,
    DocumentDiagnosticReportKind,
    type DocumentDiagnosticReport,
    type LocationLink
} from 'vscode-languageserver/node';

import {
    Position,
    TextDocument
} from 'vscode-languageserver-textdocument';

import * as WebIDL2 from 'webidl2';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;
let hasLinkSupportCapability = false;

const parsedDocuments: Record<string, WebIDL2.IDLRootType[]> = {};

function tokenContainsPosition(token: WebIDL2.Token, position: Position) {
    const { line, column, value } = token;

    // VSCode is 0-based indexed, parser is 1-based index
    if (line - 1 != position.line)
        return false;

    if (column <= position.character && (column + value.length) >= position.character)
        return true;

    return false;
}

function getTokenAtPosition(tokens: WebIDL2.Token[], position: Position): WebIDL2.Token | null {
    return tokens.find(token => tokenContainsPosition(token, position)) ?? null;
}

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;

    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.

    hasConfigurationCapability = !!capabilities?.workspace?.configuration;
    hasWorkspaceFolderCapability = !!capabilities?.workspace?.workspaceFolders;
    hasDiagnosticRelatedInformationCapability = !!capabilities?.textDocument?.publishDiagnostics?.relatedInformation;
    hasLinkSupportCapability = !!capabilities?.textDocument?.declaration?.linkSupport;

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            // Tell the client that this server supports code completion.
            completionProvider: {
                resolveProvider: true
            },
            diagnosticProvider: {
                interFileDependencies: false,
                workspaceDiagnostics: false
            },
            definitionProvider: true
        }
    };

    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true
            }
        };
    }

    return result;
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log('Workspace folder change event received.');
        });
    }
});

// The example settings
interface ExampleSettings {
    maxNumberOfProblems: number
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        // Reset all cached document settings
        documentSettings.clear();
    } else {
        globalSettings = <ExampleSettings>(
            (change.settings.languageServerExample || defaultSettings)
        );
    }
    // Refresh the diagnostics since the `maxNumberOfProblems` could have changed.
    // We could optimize things here and re-fetch the setting first can compare it
    // to the existing setting, but this is out of scope for this example.
    connection.languages.diagnostics.refresh();
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalSettings);
    }
    let result = documentSettings.get(resource);

    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'languageServerExample'
        });
        documentSettings.set(resource, result);
    }

    return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
    documentSettings.delete(e.document.uri);
});


connection.languages.diagnostics.on(async (params) => {
    const document = documents.get(params.textDocument.uri);
    if (document !== undefined) {
        return {
            kind: DocumentDiagnosticReportKind.Full,
            items: await validateTextDocument(document)
        } satisfies DocumentDiagnosticReport;
    } else {
        // We don't know the document. We can either try to read it from disk
        // or we don't report problems for it.
        return {
            kind: DocumentDiagnosticReportKind.Full,
            items: []
        } satisfies DocumentDiagnosticReport;
    }
});

function _getNodeAtPosition(ast: WebIDL2.IDLRootType, position: Position) {
    if ('members' in ast) {
        for (const member of ast.members) {
            const open = (member.tokens?.open?.line ?? 0) - 1;
            const close = (member.tokens?.termination?.line ?? member.tokens?.close?.line ?? 0) - 1;

            if (open >= 0 && close >= 0) {
                if (open <= position.line && close >= position.line) {
                    const sourceTokens = ast.source.slice(
                        member.tokens?.open?.index ?? 0,
                        (member.tokens?.termination ?? member.tokens?.close)?.index ?? 0
                    );

                    let sourceToken = null;
                    let hint = null;

                    const namedTokens = [member.tokens];

                    if ('idlType' in member && member.idlType) {
                        if (Array.isArray(member.idlType)) {
                            for (const type of member.idlType) {
                                namedTokens.push(type.tokens);
                            }
                        } else {
                            namedTokens.push(member.idlType.tokens);
                        }
                    }

                    for (const tokens of namedTokens) {
                        for (const [type, token] of Object.entries(tokens)) {
                            if (!token)
                                continue;

                            if (!tokenContainsPosition(token, position))
                                continue;

                            sourceToken = token;
                            hint = type;
                        }
                    }

                    sourceToken ??= getTokenAtPosition(sourceTokens, position);

                    return {
                        node: member,
                        token: sourceToken,
                        hint: hint
                    };
                }
            }
        }
    }

    return {
        node: ast,
        token: getTokenAtPosition(ast.source, position),
        hint: null
    };
}

function getNodeAtPosition(asts: WebIDL2.IDLRootType[], position: Position) {
    for (const ast of asts) {
        const base = (ast.tokens?.base?.line ?? 1) - 1;
        const close = (ast.tokens?.close?.line ?? 1) - 1;

        if (base <= position.line && close >= position.line)
            return _getNodeAtPosition(ast, position);
    }

    return {
        node: null,
        token: null,
        hint: null
    };
}

connection.onDefinition((params) => {
    const { textDocument, position } = params;
    const { uri } = textDocument;
    const ast = parsedDocuments[uri];

    const { node, token, hint } = getNodeAtPosition(ast, params.position);

    if (node === null || token === null)
        return null;

    if (hint === null) {
        if (node.parent !== null)
            return null;
    }

    if (hint === 'termination')
        return null;

    if (hint === 'base') {
        if ('idlType' in node && node.idlType && 'idlType' in node.idlType) {
            const idlType = node.idlType.idlType;

            if (!Array.isArray(idlType) && WebIDL2.nonRegexTerminals.includes(idlType))
                return null;
        }
    }

    console.log(hint, node, token);

    return null;
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<Diagnostic[]> {
    // const settings = await getDocumentSettings(textDocument.uri);
    const text = textDocument.getText();
    const { roots, errors } = WebIDL2.parse(text);

    const diagnostics: Diagnostic[] = [];

    for (const error of errors) {
        const token = error.tokens[0];

        const diagnostic: Diagnostic = {
            severity: DiagnosticSeverity.Error,
            range: {
                start: {
                    line: token.line - 1,
                    character: token.column - 1
                },
                end: {
                    line: token.line - 1,
                    character: token.column + token.value.length - 1
                }
            },
            message: error.bareMessage,
            source: 'WebIDL2 LSP'
        };

        diagnostics.push(diagnostic);
    }

    parsedDocuments[textDocument.uri] = roots;

    return diagnostics;
}

connection.onDidChangeWatchedFiles(_change => {
    // Monitored files have change in VSCode
    connection.console.log('We received a file change event');
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
