import {
  RecursiveCharacterTextSplitter,
  TextSplitter,
} from "@langchain/textsplitters";
import fs from "fs";

class SQLSchemaSplitter extends TextSplitter {
  private maxCharacters: number;

  constructor(maxCharacters: number) {
    super();
    this.maxCharacters = maxCharacters;
  }

  // Helper function to parse INSERT statements
  parseValues(valuesPart: string): string[] {
    let valuesArray: string[] = [];
    let currentTuple = "";
    let nestingLevel = 0;
    let inString: boolean = false;
    let stringChar = "";
    let escapeNext = false;

    for (let i = 0; i < valuesPart.length; i++) {
      const char = valuesPart[i];
      currentTuple += char;

      if (escapeNext) {
        escapeNext = false;
      } else if (char === "\\") {
        escapeNext = true;
      } else if (char === "'" || char === '"') {
        if (inString && char === stringChar) {
          inString = false;
        } else if (!inString) {
          inString = true;
          stringChar = char;
        }
      } else if (!inString) {
        if (char === "(") {
          nestingLevel += 1;
        } else if (char === ")") {
          nestingLevel -= 1;
          if (nestingLevel === 0) {
            valuesArray.push(currentTuple.trim());
            currentTuple = "";
            // Skip any commas and spaces
            while (
              i + 1 < valuesPart.length &&
              (valuesPart[i + 1] === "," ||
                valuesPart[i + 1] === " " ||
                valuesPart[i + 1] === "\n")
            ) {
              i++;
            }
          }
        }
      }
    }
    return valuesArray;
  }

  // Split long INSERT statements
  splitInsertStatement(statement: string): string[] {
    const insertIndex = statement.toUpperCase().indexOf("VALUES");
    if (insertIndex === -1) {
      // Cannot split, return the statement as is
      return [statement];
    }

    const insertIntoPart =
      statement.slice(0, insertIndex + "VALUES".length) + " ";
    const valuesPart = statement.slice(insertIndex + "VALUES".length);

    const valuesArray = this.parseValues(valuesPart);
    const insertStatements: string[] = [];

    let currentValues = "";
    for (const valueTuple of valuesArray) {
      const newStatementLength =
        insertIntoPart.length + currentValues.length + valueTuple.length + 1; // +1 for ',' or ';'

      if (newStatementLength <= this.maxCharacters) {
        if (currentValues !== "") {
          currentValues += "," + valueTuple;
        } else {
          currentValues = valueTuple;
        }
      } else {
        // Create a new INSERT statement
        const newStatement = insertIntoPart + currentValues + ";";
        insertStatements.push(newStatement);
        currentValues = valueTuple;
      }
    }
    if (currentValues !== "") {
      const newStatement = insertIntoPart + currentValues + ";";
      insertStatements.push(newStatement);
    }
    return insertStatements;
  }

  /**
   * Enhanced function to split SQL script into statements while handling various SQL constructs,
   * including custom keywords like BBEGI/EEN and EEXCEPTIO/EEN.
   */
  splitSQLStatements(text: string): string[] {
    const statements: string[] = [];
    let currentStatement = "";
    let index = 0;
    let insideString: boolean = false;
    let stringChar = "";
    let insideComment = false;
    let commentType = "";
    let insideFunction = false;
    let insideProcedure = false;
    let insideView = false;
    let insideBlock = false;
    let blockLevel = 0;

    const upperText = text.toUpperCase();

    // Define mappings for custom keywords to standard ones
    const beginKeywords = ["BEGIN", "BBEGI", "BEGINN"];
    const endKeywords = ["END", "EEN"];
    const exceptionKeywords = ["EXCEPTION", "EEXCEPTIO"];

    while (index < text.length) {
      const char = text[index];
      const remainingText = upperText.substring(index);
      currentStatement += char;

      if (insideString) {
        if (char === stringChar) {
          insideString = false;
        } else if (char === "\\") {
          // Skip escaped characters
          index++;
          if (index < text.length) {
            currentStatement += text[index];
          }
        }
      } else if (insideComment) {
        if (commentType === "--" && (char === "\n" || char === "\r")) {
          insideComment = false;
        } else if (commentType === "/*" && remainingText.startsWith("*/")) {
          insideComment = false;
          currentStatement += "*/";
          index += 1; // Skip '/'
        }
      } else if (char === "'" || char === '"') {
        insideString = true;
        stringChar = char;
      } else if (remainingText.startsWith("/*")) {
        insideComment = true;
        commentType = "/*";
        currentStatement += "/*";
        index += 1; // Skip '*'
      } else if (remainingText.startsWith("--")) {
        insideComment = true;
        commentType = "--";
        currentStatement += "--";
        index += 1; // Skip second '-'
      } else if (
        !insideFunction &&
        !insideProcedure &&
        !insideView &&
        !insideBlock
      ) {
        if (
          remainingText.startsWith("CREATE FUNCTION") ||
          remainingText.startsWith("CREATE OR REPLACE FUNCTION")
        ) {
          insideFunction = true;
          blockLevel = 0;
        } else if (
          remainingText.startsWith("CREATE PROCEDURE") ||
          remainingText.startsWith("CREATE OR REPLACE PROCEDURE")
        ) {
          insideProcedure = true;
          blockLevel = 0;
        } else if (
          remainingText.startsWith("CREATE VIEW") ||
          remainingText.startsWith("CREATE OR REPLACE VIEW")
        ) {
          insideView = true;
        } else if (beginKeywords.some((kw) => remainingText.startsWith(kw))) {
          insideBlock = true;
          blockLevel = 1;
          const matchedBegin = beginKeywords.find((kw) =>
            remainingText.startsWith(kw)
          );
          if (matchedBegin && matchedBegin.length > "BEGIN".length) {
            index += matchedBegin.length - "BEGIN".length;
            currentStatement += matchedBegin.substring("BEGIN".length);
          }
        }
      }

      if (insideFunction || insideProcedure || insideBlock) {
        // Check for BEGIN keywords to increase block level
        const matchedBegin = beginKeywords.find((kw) =>
          remainingText.startsWith(kw)
        );
        if (matchedBegin) {
          blockLevel++;
          index += matchedBegin.length - 1;
          currentStatement += matchedBegin.substring(1);
          continue;
        }

        // Check for END keywords to decrease block level
        const matchedEnd = endKeywords.find((kw) =>
          remainingText.startsWith(kw)
        );
        if (
          matchedEnd &&
          (matchedEnd.length === "END".length ||
            matchedEnd.length === "END;".length)
        ) {
          blockLevel--;
          index += matchedEnd.length - 1;
          currentStatement += matchedEnd.substring(1);

          if (blockLevel === 0) {
            if (insideFunction) {
              insideFunction = false;
              statements.push(currentStatement.trim());
              currentStatement = "";
            } else if (insideProcedure) {
              insideProcedure = false;
              statements.push(currentStatement.trim());
              currentStatement = "";
            } else if (insideBlock) {
              insideBlock = false;
              statements.push(currentStatement.trim());
              currentStatement = "";
            }
          }
          continue;
        }
      } else if (insideView) {
        if (char === ";") {
          insideView = false;
          statements.push(currentStatement.trim());
          currentStatement = "";
        }
      } else if (
        char === ";" &&
        !insideFunction &&
        !insideProcedure &&
        !insideView &&
        !insideBlock
      ) {
        statements.push(currentStatement.trim());
        currentStatement = "";
      }

      index++;
    }

    if (currentStatement.trim() !== "") {
      statements.push(currentStatement.trim());
    }

    return statements;
  }

  // Helper method to match keywords from a list at the start of the given text.
  // Returns the matched keyword or null.
  matchKeyword(text: string, keywords: string[]): string | null {
    for (const keyword of keywords) {
      if (text.startsWith(keyword)) {
        return keyword;
      }
    }
    return null;
  }

  async splitText(text: string): Promise<string[]> {
    const statements = this.splitSQLStatements(text);
    const splits: string[] = [];

    for (const statement of statements) {
      // Check if the statement is an INSERT statement
      if (
        statement.toUpperCase().includes("INSERT INTO") &&
        statement.toUpperCase().includes("VALUES")
      ) {
        // Split long INSERT statements
        const splitInserts = this.splitInsertStatement(statement);
        splits.push(...splitInserts);
      } else {
        // For other statements, check if they are too long
        if (statement.length <= this.maxCharacters) {
          splits.push(statement);
        } else {
          // For long statements, split them into chunks
          let currentSplit = "";
          const lines = statement.split("\n");

          for (const line of lines) {
            if (currentSplit.length + line.length + 1 <= this.maxCharacters) {
              currentSplit += (currentSplit ? "\n" : "") + line;
            } else {
              if (currentSplit) {
                splits.push(currentSplit);
              }
              currentSplit = line;
            }
          }

          if (currentSplit) {
            splits.push(currentSplit);
          }
        }
      }
    }

    return splits;
  }
}

export function extensionToSplitter(extension: string): string {
  if (!extension) {
    return "text";
  }
  const extensionLower = extension.toLowerCase();
  switch (extensionLower) {
    // C/C++ extensions
    case "c++":
    case "cpp":
    case "c":
    case "h":
    case "hpp":
    case "m":
    case "mm":
      return "cpp";
    // Go
    case "go":
      return "go";
    // Java
    case "java":
      return "java";
    // JavaScript and related
    case "js":
    case "ts":
    case "typescript":
    case "tsx":
    case "jsx":
    case "javascript":
    case "json":
    case "pbxproj":
      return "js";
    // YAML and related
    case "yaml":
    case "yml":
    case "toml":
    case "ini":
    case "cfg":
    case "conf":
    case "props":
    case "env":
    case "plist":
    case "gemfile":
    case "dockerfile":
    case "podfile":
    case "patch":
      return "text";
    // Shell scripts and related
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "bat":
    case "cmd":
      return "text";
    // Properties and XSD
    case "properties":
    case "xsd":
      return "text";
    // SQL
    case "sql":
      return "sql";
    // PHP
    case "php":
      return "php";
    // Protocol buffers
    case "proto":
      return "proto";
    // Python
    case "py":
    case "python":
      return "python";
    // reStructuredText
    case "rst":
      return "rst";
    // Ruby
    case "rb":
    case "ruby":
      return "ruby";
    // Rust
    case "rs":
    case "rust":
      return "rust";
    // Scala
    case "scala":
      return "scala";
    // Swift
    case "swift":
      return "swift";
    // Markdown
    case "md":
    case "markdown":
      return "markdown";
    // LaTeX
    case "tex":
    case "latex":
      return "latex";
    // HTML and related
    case "html":
    case "htm":
    case "xml":
    case "xsl":
    case "xdt":
    case "xcworkspacedata":
    case "xcprivacy":
    case "xcsettings":
    case "xcscheme":
      return "html";
    // Solidity
    case "sol":
    case "solidity":
      return "sol";
    // Text
    case "text":
    case "txt":
    case "lst":
    case "reg":
      return "text";
    // Additional file extensions
    case "jpr":
    case "jws":
    case "iml":
      return "html";
    case "lock":
    case "jpg":
    case "jpeg":
    case "png":
    case "gif":
    case "bmp":
    case "svg":
    case "ico":
    case "webp":
    case "tiff":
    case "bin":
    case "exe":
    case "dll":
    case "so":
    case "dylib":
    case "obj":
    case "o":
    case "zip":
    case "tar":
    case "gz":
    case "rar":
    case "7z":
    case "jar":
    case "war":
    case "ear":
    case "class":
      return "ignore";
    default:
      return "text";
  }
}

export const splitDocument = (filename: string, code: string) => {
  const extension = filename.split(".").pop();

  const splitType = extensionToSplitter(extension || "");
  if (splitType === "ignore") {
    return [];
  }

  const CHUNK_SIZE_TOKENS = 7000;
  const CHUNK_OVERLAP_TOKENS = 200;

  const CHUNK_SIZE_CHARACTERS = CHUNK_SIZE_TOKENS * 3.25;
  const CHUNK_OVERLAP_CHARACTERS = CHUNK_OVERLAP_TOKENS * 3.25;

  let splitter;

  if (splitType !== "text" && splitType !== "sql") {
    splitter = RecursiveCharacterTextSplitter.fromLanguage(
      splitType as
        | "cpp"
        | "go"
        | "java"
        | "js"
        | "php"
        | "proto"
        | "python"
        | "rst"
        | "ruby"
        | "rust"
        | "scala"
        | "swift"
        | "markdown"
        | "latex"
        | "html"
        | "sol",
      {
        chunkSize: CHUNK_SIZE_CHARACTERS,
        chunkOverlap: CHUNK_OVERLAP_CHARACTERS,
      }
    );
  } else if (splitType === "sql") {
    splitter = new SQLSchemaSplitter(CHUNK_SIZE_CHARACTERS);
  } else {
    splitter = new RecursiveCharacterTextSplitter({
      chunkSize: CHUNK_SIZE_CHARACTERS,
      chunkOverlap: CHUNK_OVERLAP_CHARACTERS,
    });
  }
  return splitter.createDocuments([code], [], {
    chunkHeader: `FILE NAME: ${filename}\n\n---\n\n`,
    appendChunkOverlapHeader: true,
  });
};
