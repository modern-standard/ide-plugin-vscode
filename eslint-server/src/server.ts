/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	createConnection, IConnection,
	ResponseError, RequestType, IRequestHandler, NotificationType, INotificationHandler,
	InitializeResult, InitializeError,
	Diagnostic, DiagnosticSeverity, Position, Files,
	TextDocuments, ITextDocument, TextDocumentSyncKind,
	ErrorMessageTracker
} from 'vscode-languageserver';

import fs = require('fs');
import path = require('path');

interface Settings {
	standard: {
		enable: boolean;
		options: any;
	}
	[key: string]: any;
}

interface ESLintProblem {
	line: number;
	column: number;
	severity: number;
	ruleId: string;
	message: string;
}

interface ESLintDocumentReport {
	filePath: string;
	errorCount: number;
	warningCount: number;
	messages: ESLintProblem[];
}

interface ESLintReport {
	errorCount: number;
	warningCount: number;
	results: ESLintDocumentReport[];
}

function makeDiagnostic(problem: ESLintProblem): Diagnostic {
	return {
		message: problem.message,
		severity: convertSeverity(problem.severity),
		range: {
			start: { line: problem.line - 1, character: problem.column - 1 },
			end: { line: problem.line - 1, character: problem.column - 1 }
		}
	};
}

function convertSeverity(severity: number): number {
	switch (severity) {
		// Eslint 1 is warning
		case 1:
			return DiagnosticSeverity.Warning;
		case 2:
			return DiagnosticSeverity.Error;
		default:
			return DiagnosticSeverity.Error;
	}
}

let connection: IConnection = createConnection(process.stdin, process.stdout);
let lib: any = null;
let settings: Settings = null;
let options: any = null;
let documents: TextDocuments = new TextDocuments();

// The documents manager listen for text document create, change
// and close on the connection
documents.listen(connection);
// A text document has changed. Validate the document.
documents.onDidChangeContent((event) => {
	validateSingle(event.document);
});

connection.onInitialize((params): Thenable<InitializeResult | ResponseError<InitializeError>> => {
	let rootPath = params.rootPath;
	return Files.resolveModule(rootPath, 'modern-standard').then((value): InitializeResult | ResponseError<InitializeError> => {
		if (!value.lintText) {
			return new ResponseError(99, 'The modern-standard library doesn\'t export a lintText property.', { retry: false });
		}
		lib = value;
		let result: InitializeResult = { capabilities: { textDocumentSync: documents.syncKind }};
		return result;
	}, (error) => {
		return Promise.reject(
			new ResponseError<InitializeError>(99,
				'Failed to load modern-standard library. Please install standard in your workspace folder using \'npm install standard\' and then press Retry.',
				{ retry: true }));
	});
})

function getMessage(err: any, document: ITextDocument): string {
	let result: string = null;
	if (typeof err.message === 'string' || err.message instanceof String) {
		result = <string>err.message;
		result = result.replace(/\r?\n/g, ' ');
		if (/^CLI: /.test(result)) {
			result = result.substr(5);
		}
	} else {
		result = `An unknown error occured while validating file: ${Files.uriToFilePath(document.uri)}`;
	}
	return result;
}

function validate(document: ITextDocument): void {
	let content = document.getText();
	let uri = document.uri;
	lib.lintText(content, options, function (error, results) {
		let report: ESLintReport = results
		let diagnostics: Diagnostic[] = [];
		if (report && report.results && Array.isArray(report.results) && report.results.length > 0) {
			let docReport = report.results[0];
			if (docReport.messages && Array.isArray(docReport.messages)) {
				docReport.messages.forEach((problem) => {
					if (problem) {
						diagnostics.push(makeDiagnostic(problem));
					}
				});
			}
		}
		// Publish the diagnostics
		return connection.sendDiagnostics({ uri, diagnostics });
	});

}

function validateSingle(document: ITextDocument): void {
	try {
		validate(document);
	} catch (err) {
		connection.window.showErrorMessage(getMessage(err, document));
	}
}

function validateMany(documents: ITextDocument[]): void {
	let tracker = new ErrorMessageTracker();
	documents.forEach(document => {
		try {
			validate(document);
		} catch (err) {
			tracker.add(getMessage(err, document));
		}
	});
	tracker.sendErrors(connection);
}

connection.onDidChangeConfiguration((params) => {
	settings = params.settings;
	if (settings.standard) {
		options = settings.standard.options || {};
	}
	// Settings have changed. Revalidate all documents.
	validateMany(documents.all());
});

connection.onDidChangeWatchedFiles((params) => {
	// A .eslintrc has change. No smartness here.
	// Simply revalidate all file.
	validateMany(documents.all());
});

connection.listen();