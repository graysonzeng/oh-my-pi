//! Code-intelligence tags, name-cooccurrence graph, PageRank, chunking,
//! and generation snapshot I/O.
//!
//! Identifier tags are a name graph, not a call graph. Call edges are a
//! separate capture (`call.name`) used only by the call-expression resolver.

use std::{
	collections::{HashMap, HashSet},
	fs::{self, File},
	io::{BufRead, BufReader, Write},
	path::{Path, PathBuf},
	sync::LazyLock,
};

use ast_grep_core::tree_sitter::LanguageExt;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_ast::{SupportLang, parse_cache::parse_cached};
use serde::{Deserialize, Serialize};
use tree_sitter::{Query, QueryCursor, StreamingIterator};

use crate::{iofs, task};

const DEFAULT_MAX_FILES: u32 = 20_000;
const DEFAULT_TOP_FILES: u32 = 8;
const DEFAULT_TOP_SYMBOLS: u32 = 16;
const PAGERANK_DAMPING: f64 = 0.85;
const PAGERANK_MAX_ITERS: usize = 20;
const PAGERANK_EPSILON: f64 = 1e-4;
const CHUNK_MAX_DEF_LINES: u32 = 200;
const CHUNK_WINDOW: u32 = 80;
const CHUNK_OVERLAP: u32 = 40;
const HASH_SEED: u64 = 0x4349_4e54_4841_5348;
const MANIFEST_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum CodeIntelTagKind {
	#[napi(value = "def")]
	Def,
	#[napi(value = "ref")]
	Ref,
}

/// One definition or identifier reference extracted from a source file.
#[derive(Clone, Debug)]
#[napi(object)]
pub struct CodeIntelTag {
	pub path:       String,
	pub name:       String,
	pub kind:       CodeIntelTagKind,
	pub grammar:    String,
	pub start_line: u32,
	pub end_line:   u32,
}

/// Ranked symbol/file node from personalized PageRank.
#[derive(Clone, Debug)]
#[napi(object)]
pub struct CodeIntelRankedNode {
	pub path:       String,
	pub symbol:     String,
	pub score:      f64,
	pub start_line: u32,
	pub end_line:   u32,
}

/// A source chunk for embedding / retrieval.
#[derive(Clone, Debug)]
#[napi(object)]
pub struct CodeIntelChunk {
	pub start_line: u32,
	pub end_line:   u32,
	pub symbol:     String,
	pub kind:       String,
	pub text:       String,
}

/// A verified call-expression capture (callee name + span).
#[derive(Clone, Debug)]
#[napi(object)]
pub struct CodeIntelCall {
	pub path:       String,
	pub callee:     String,
	pub start_line: u32,
	pub end_line:   u32,
}

#[napi(object)]
pub struct CodeIntelExtractOptions<'env> {
	pub root:      String,
	pub hidden:    Option<bool>,
	pub gitignore: Option<bool>,
	pub max_files: Option<u32>,
	pub signal:    Option<Unknown<'env>>,
	pub timeout_ms: Option<u32>,
}

#[napi(object)]
pub struct CodeIntelExtractResult {
	pub tags:          Vec<CodeIntelTag>,
	pub calls:         Vec<CodeIntelCall>,
	pub files_scanned: u32,
	pub parse_errors:  Vec<String>,
}

#[napi(object)]
pub struct CodeIntelBuildOptions<'env> {
	pub root:       String,
	pub dest_dir:   String,
	pub hidden:     Option<bool>,
	pub gitignore:  Option<bool>,
	pub max_files:  Option<u32>,
	pub signal:     Option<Unknown<'env>>,
	pub timeout_ms: Option<u32>,
}

#[napi(object)]
pub struct CodeIntelBuildResult {
	pub files_scanned: u32,
	pub tag_count:     u32,
	pub chunk_count:   u32,
	pub parse_errors:  Vec<String>,
}

#[napi(object)]
pub struct CodeIntelRankOptions {
	pub generation_dir: String,
	pub seed_paths:     Option<Vec<String>>,
	pub seed_symbols:   Option<Vec<String>>,
	pub top_files:      Option<u32>,
	pub top_symbols:    Option<u32>,
}

#[napi(object)]
pub struct CodeIntelChunkOptions {
	pub path:    String,
	pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredTag {
	path:       String,
	name:       String,
	kind:       String,
	grammar:    String,
	start_line: u32,
	end_line:   u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredFile {
	path:         String,
	mtime_ms:     f64,
	size:         u64,
	content_hash: String,
	tag_count:    u32,
	chunk_ids:    Vec<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredChunk {
	id:           u32,
	path:         String,
	start_line:   u32,
	end_line:     u32,
	symbol:       String,
	kind:         String,
	text_hash:    String,
	content_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredCall {
	path:       String,
	callee:     String,
	start_line: u32,
	end_line:   u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Manifest {
	version:          u32,
	root:             String,
	git_head:         Option<String>,
	embedding_model:  Option<String>,
	dim:              u32,
	file_count:       u32,
	tag_count:        u32,
	chunk_count:      u32,
	tags_hash:        String,
	chunks_hash:      String,
	embeddings_rows:  u32,
	embeddings_dim:   u32,
	graph_hash:       String,
}

struct FileExtraction {
	tags:   Vec<CodeIntelTag>,
	calls:  Vec<CodeIntelCall>,
	chunks: Vec<CodeIntelChunk>,
}

struct CompiledQueries {
	tags:  Query,
	calls: Option<Query>,
}

fn tags_query_source(lang: SupportLang) -> Option<&'static str> {
	Some(match lang {
		SupportLang::Rust => {
			r#"
(function_item name: (identifier) @definition.function)
(struct_item name: (type_identifier) @definition.class)
(enum_item name: (type_identifier) @definition.class)
(trait_item name: (type_identifier) @definition.class)
(mod_item name: (identifier) @definition.module)
(impl_item type: (type_identifier) @definition.class)
(identifier) @reference.identifier
(type_identifier) @reference.identifier
"#
		},
		SupportLang::TypeScript | SupportLang::Tsx | SupportLang::JavaScript => {
			r#"
(function_declaration name: (identifier) @definition.function)
(generator_function_declaration name: (identifier) @definition.function)
(class_declaration name: (type_identifier) @definition.class)
(class_declaration name: (identifier) @definition.class)
(method_definition name: (property_identifier) @definition.method)
(method_definition name: (identifier) @definition.method)
(interface_declaration name: (type_identifier) @definition.class)
(type_alias_declaration name: (type_identifier) @definition.class)
(identifier) @reference.identifier
(type_identifier) @reference.identifier
(property_identifier) @reference.identifier
"#
		},
		SupportLang::Python => {
			r#"
(function_definition name: (identifier) @definition.function)
(class_definition name: (identifier) @definition.class)
(identifier) @reference.identifier
"#
		},
		SupportLang::Go => {
			r#"
(function_declaration name: (identifier) @definition.function)
(method_declaration name: (field_identifier) @definition.method)
(type_spec name: (type_identifier) @definition.class)
(identifier) @reference.identifier
(field_identifier) @reference.identifier
(type_identifier) @reference.identifier
"#
		},
		SupportLang::Java => {
			r#"
(method_declaration name: (identifier) @definition.method)
(class_declaration name: (identifier) @definition.class)
(interface_declaration name: (identifier) @definition.class)
(identifier) @reference.identifier
"#
		},
		SupportLang::C | SupportLang::Cpp => {
			r#"
(function_definition
  declarator: (function_declarator declarator: (identifier) @definition.function))
(function_definition
  declarator: (function_declarator
    declarator: (qualified_identifier (identifier) @definition.function)))
(class_specifier name: (type_identifier) @definition.class)
(struct_specifier name: (type_identifier) @definition.class)
(identifier) @reference.identifier
(type_identifier) @reference.identifier
"#
		},
		_ => return None,
	})
}

fn calls_query_source(lang: SupportLang) -> Option<&'static str> {
	Some(match lang {
		SupportLang::Rust => {
			r#"
(call_expression function: (identifier) @call.name)
(call_expression function: (field_expression field: (field_identifier) @call.name))
"#
		},
		SupportLang::TypeScript | SupportLang::Tsx | SupportLang::JavaScript => {
			r#"
(call_expression function: (identifier) @call.name)
(call_expression function: (member_expression property: (property_identifier) @call.name))
"#
		},
		SupportLang::Python => {
			r#"
(call function: (identifier) @call.name)
(call function: (attribute attribute: (identifier) @call.name))
"#
		},
		SupportLang::Go => {
			r#"
(call_expression function: (identifier) @call.name)
(call_expression function: (selector_expression field: (field_identifier) @call.name))
"#
		},
		SupportLang::Java => {
			r#"
(method_invocation name: (identifier) @call.name)
"#
		},
		SupportLang::C | SupportLang::Cpp => {
			r#"
(call_expression function: (identifier) @call.name)
(call_expression function: (field_expression field: (field_identifier) @call.name))
"#
		},
		_ => return None,
	})
}

fn compile_queries(lang: SupportLang) -> Option<&'static CompiledQueries> {
	static CACHE: LazyLock<HashMap<SupportLang, CompiledQueries>> = LazyLock::new(|| {
		let langs = [
			SupportLang::Rust,
			SupportLang::TypeScript,
			SupportLang::Tsx,
			SupportLang::JavaScript,
			SupportLang::Python,
			SupportLang::Go,
			SupportLang::Java,
			SupportLang::C,
			SupportLang::Cpp,
		];
		let mut map = HashMap::new();
		for lang in langs {
			let ts_lang = lang.get_ts_language();
			let Some(source) = tags_query_source(lang) else {
				continue;
			};
			let Ok(tags) = Query::new(&ts_lang, source) else {
				continue;
			};
			let calls = calls_query_source(lang).and_then(|src| Query::new(&ts_lang, src).ok());
			map.insert(lang, CompiledQueries { tags, calls });
		}
		map
	});
	CACHE.get(&lang)
}

fn content_hash(bytes: &[u8]) -> String {
	format!("{:016x}", xxhash_rust::xxh64::xxh64(bytes, HASH_SEED))
}

fn line_of(byte: usize, starts: &[usize]) -> u32 {
	match starts.binary_search(&byte) {
		Ok(idx) => (idx + 1) as u32,
		Err(idx) => idx.max(1) as u32,
	}
}

fn line_starts(source: &str) -> Vec<usize> {
	let mut starts = vec![0];
	for (idx, ch) in source.char_indices() {
		if ch == '\n' {
			starts.push(idx + 1);
		}
	}
	starts
}

fn extract_from_source(path: &str, source: &str, lang: SupportLang) -> std::result::Result<FileExtraction, String> {
	let Some(compiled) = compile_queries(lang) else {
		return Ok(FileExtraction {
			tags: Vec::new(),
			calls: Vec::new(),
			chunks: chunk_windows(source, path),
		});
	};
	let tree = parse_cached(source, lang).map_err(|err| err.to_string())?;
	let Some(tree) = tree else {
		return Ok(FileExtraction {
			tags: Vec::new(),
			calls: Vec::new(),
			chunks: chunk_windows(source, path),
		});
	};
	let root = tree.root_node();
	let starts = line_starts(source);
	let bytes = source.as_bytes();
	let grammar = lang.canonical_name().to_string();

	let mut defs: Vec<CodeIntelTag> = Vec::new();
	let mut refs: Vec<CodeIntelTag> = Vec::new();
	let mut def_spans: HashSet<(u32, u32, String)> = HashSet::new();
	let mut cursor = QueryCursor::new();
	let mut matches = cursor.matches(&compiled.tags, root, bytes);
	while let Some(m) = matches.next() {
		for capture in m.captures {
			let name = compiled.tags.capture_names()[capture.index as usize];
			let node = capture.node;
			let text = node.utf8_text(bytes).unwrap_or("").to_string();
			if text.is_empty() || !is_symbol_name(&text) {
				continue;
			}
			let start_line = line_of(node.start_byte(), &starts);
			let end_line = line_of(node.end_byte().saturating_sub(1), &starts).max(start_line);
			let tag = CodeIntelTag {
				path: path.to_string(),
				name: text.clone(),
				kind: if name.starts_with("definition.") {
					CodeIntelTagKind::Def
				} else {
					CodeIntelTagKind::Ref
				},
				grammar: grammar.clone(),
				start_line,
				end_line,
			};
			if name.starts_with("definition.") {
				def_spans.insert((start_line, end_line, text));
				defs.push(tag);
			} else {
				refs.push(tag);
			}
		}
	}

	let refs = refs
		.into_iter()
		.filter(|tag| !def_spans.contains(&(tag.start_line, tag.end_line, tag.name.clone())))
		.collect::<Vec<_>>();

	let mut calls = Vec::new();
	if let Some(call_query) = compiled.calls.as_ref() {
		let mut call_cursor = QueryCursor::new();
		let mut call_matches = call_cursor.matches(call_query, root, bytes);
		while let Some(m) = call_matches.next() {
			for capture in m.captures {
				let name = call_query.capture_names()[capture.index as usize];
				if name != "call.name" {
					continue;
				}
				let node = capture.node;
				let text = node.utf8_text(bytes).unwrap_or("").to_string();
				if text.is_empty() || !is_symbol_name(&text) {
					continue;
				}
				let start_line = line_of(node.start_byte(), &starts);
				let end_line = line_of(node.end_byte().saturating_sub(1), &starts).max(start_line);
				calls.push(CodeIntelCall {
					path: path.to_string(),
					callee: text,
					start_line,
					end_line,
				});
			}
		}
	}

	let mut tags = defs.clone();
	tags.extend(refs);
	let chunks = chunk_from_defs(source, path, &defs);
	Ok(FileExtraction { tags, calls, chunks })
}

fn is_symbol_name(name: &str) -> bool {
	let mut chars = name.chars();
	let Some(first) = chars.next() else {
		return false;
	};
	(first.is_ascii_alphabetic() || first == '_')
		&& chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
		&& name.len() <= 128
}

fn chunk_from_defs(source: &str, _path: &str, defs: &[CodeIntelTag]) -> Vec<CodeIntelChunk> {
	if defs.is_empty() {
		return chunk_windows(source, "");
	}
	let lines: Vec<&str> = source.lines().collect();
	let total = lines.len() as u32;
	let mut chunks = Vec::new();
	let mut covered = vec![false; lines.len()];
	for def in defs {
		let start = def.start_line.max(1);
		let mut end = def.end_line.max(start);
		if end.saturating_sub(start) + 1 > CHUNK_MAX_DEF_LINES {
			end = start + CHUNK_MAX_DEF_LINES - 1;
		}
		end = end.min(total.max(1));
		let text = slice_lines(&lines, start, end);
		for line in start..=end {
			if let Some(flag) = covered.get_mut((line - 1) as usize) {
				*flag = true;
			}
		}
		chunks.push(CodeIntelChunk {
			start_line: start,
			end_line: end,
			symbol: def.name.clone(),
			kind: "def".to_string(),
			text,
		});
	}
	let mut idx = 1u32;
	while idx <= total {
		if covered.get((idx - 1) as usize).copied().unwrap_or(false) {
			idx += 1;
			continue;
		}
		let start = idx;
		let mut end = (start + CHUNK_WINDOW - 1).min(total);
		while end > start && covered.get((end - 1) as usize).copied().unwrap_or(false) {
			end -= 1;
		}
		chunks.push(CodeIntelChunk {
			start_line: start,
			end_line: end,
			symbol: String::new(),
			kind: "window".to_string(),
			text: slice_lines(&lines, start, end),
		});
		idx = end + 1;
	}
	chunks
}

fn chunk_windows(source: &str, _path: &str) -> Vec<CodeIntelChunk> {
	let lines: Vec<&str> = source.lines().collect();
	if lines.is_empty() {
		return Vec::new();
	}
	let total = lines.len() as u32;
	let mut chunks = Vec::new();
	let mut start = 1u32;
	while start <= total {
		let end = (start + CHUNK_WINDOW - 1).min(total);
		chunks.push(CodeIntelChunk {
			start_line: start,
			end_line: end,
			symbol: String::new(),
			kind: "window".to_string(),
			text: slice_lines(&lines, start, end),
		});
		if end == total {
			break;
		}
		start = start.saturating_add(CHUNK_WINDOW.saturating_sub(CHUNK_OVERLAP)).max(end);
		if start <= end {
			start = end + 1;
		}
	}
	chunks
}

fn slice_lines(lines: &[&str], start: u32, end: u32) -> String {
	let from = start.saturating_sub(1) as usize;
	let to = (end as usize).min(lines.len());
	if from >= to {
		return String::new();
	}
	lines[from..to].join("\n")
}

fn collect_source_files(
	root: &Path,
	hidden: bool,
	gitignore: bool,
	max_files: usize,
	ct: &task::CancelToken,
) -> napi::Result<Vec<(PathBuf, String)>> {
	if root.is_file() {
		let display = root
			.file_name()
			.and_then(|name| name.to_str())
			.unwrap_or("file")
			.to_string();
		return Ok(vec![(root.to_path_buf(), display)]);
	}
	let filter = pi_walker::WalkFilter::files_only().node_modules_unless_mentioned(false);
	let request = pi_walker::WalkRequest::new(root)
		.hidden(hidden)
		.gitignore(gitignore)
		.skip_git(true)
		.follow_links(pi_walker::FollowLinks::Never)
		.detail(pi_walker::WalkDetail::Full)
		.order(pi_walker::WalkOrder::Path)
		.emit_root(false)
		.depth(1, usize::MAX)
		.directory_errors(pi_walker::DirectoryErrorMode::SkipSkippable)
		.cache(true)
		.empty_recheck(pi_walker::EmptyRecheck::Configured)
		.filter(filter)
		.limit(max_files);
	let files = request
		.collect_files_with_heartbeat(|| ct.heartbeat())
		.map_err(iofs::map_walker_error)?;
	Ok(files
		.into_iter()
		.map(|entry| (entry.absolute_path(root), entry.path))
		.collect())
}

fn extract_tree(
	root: &Path,
	hidden: bool,
	gitignore: bool,
	max_files: usize,
	ct: &task::CancelToken,
) -> napi::Result<(Vec<FileExtraction>, u32, Vec<String>, Vec<StoredFile>)> {
	let files = collect_source_files(root, hidden, gitignore, max_files, ct)?;
	let mut extractions = Vec::new();
	let mut parse_errors = Vec::new();
	let mut stored_files = Vec::new();
	let mut scanned = 0u32;
	for (absolute, display) in files {
		ct.heartbeat()?;
		scanned = scanned.saturating_add(1);
		let Some(lang) = SupportLang::from_path(&absolute) else {
			continue;
		};
		let source = match fs::read_to_string(&absolute) {
			Ok(source) => source,
			Err(err) => {
				parse_errors.push(format!("{display}: {err}"));
				continue;
			},
		};
		match extract_from_source(&display, &source, lang) {
			Ok(extracted) => {
				let metadata = fs::metadata(&absolute).ok();
				stored_files.push(StoredFile {
					path: display,
					mtime_ms: metadata
						.as_ref()
						.and_then(|meta| meta.modified().ok())
						.and_then(|time| {
							time.duration_since(std::time::UNIX_EPOCH)
								.ok()
								.map(|d| d.as_secs_f64() * 1000.0)
						})
						.unwrap_or(0.0),
					size: metadata.as_ref().map(|meta| meta.len()).unwrap_or(source.len() as u64),
					content_hash: content_hash(source.as_bytes()),
					tag_count: extracted.tags.len() as u32,
					chunk_ids: Vec::new(),
				});
				extractions.push(extracted);
			},
			Err(err) => parse_errors.push(format!("{display}: {err}")),
		}
	}
	Ok((extractions, scanned, parse_errors, stored_files))
}

/// Extract tags and call-expressions from a file or directory (tests / diagnostics).
#[napi]
pub fn code_intel_extract_tags(options: CodeIntelExtractOptions<'_>) -> task::Promise<CodeIntelExtractResult> {
	let CodeIntelExtractOptions { root, hidden, gitignore, max_files, signal, timeout_ms } =
		options;
	let ct = task::CancelToken::new(timeout_ms, signal);
	task::blocking("code_intel_extract_tags", ct, move |ct| {
		let root = PathBuf::from(root);
		let (extractions, files_scanned, parse_errors, _) = extract_tree(
			&root,
			hidden.unwrap_or(true),
			gitignore.unwrap_or(true),
			max_files.unwrap_or(DEFAULT_MAX_FILES) as usize,
			&ct,
		)?;
		let mut tags = Vec::new();
		let mut calls = Vec::new();
		for extracted in extractions {
			tags.extend(extracted.tags);
			calls.extend(extracted.calls);
		}
		Ok(CodeIntelExtractResult { tags, calls, files_scanned, parse_errors })
	})
}

/// Build a generation directory: files/tags/chunks/graph. Does not write embeddings.
#[napi]
pub fn code_intel_build_generation(options: CodeIntelBuildOptions<'_>) -> task::Promise<CodeIntelBuildResult> {
	let CodeIntelBuildOptions {
		root,
		dest_dir,
		hidden,
		gitignore,
		max_files,
		signal,
		timeout_ms,
	} = options;
	let ct = task::CancelToken::new(timeout_ms, signal);
	task::blocking("code_intel_build_generation", ct, move |ct| {
		let root_path = PathBuf::from(&root);
		let dest = PathBuf::from(&dest_dir);
		fs::create_dir_all(&dest).map_err(|err| Error::from_reason(format!("create dest: {err}")))?;
		let (extractions, files_scanned, parse_errors, mut stored_files) = extract_tree(
			&root_path,
			hidden.unwrap_or(true),
			gitignore.unwrap_or(true),
			max_files.unwrap_or(DEFAULT_MAX_FILES) as usize,
			&ct,
		)?;

		let mut tags = Vec::new();
		let mut calls = Vec::new();
		let mut chunks = Vec::new();
		let mut chunk_id = 0u32;
		for (extracted, file) in extractions.into_iter().zip(stored_files.iter_mut()) {
			let mut ids = Vec::new();
			for chunk in extracted.chunks {
				ids.push(chunk_id);
				chunks.push(StoredChunk {
					id: chunk_id,
					path: file.path.clone(),
					start_line: chunk.start_line,
					end_line: chunk.end_line,
					symbol: chunk.symbol,
					kind: chunk.kind,
					text_hash: content_hash(chunk.text.as_bytes()),
					content_hash: file.content_hash.clone(),
				});
				chunk_id += 1;
			}
			file.chunk_ids = ids;
			tags.extend(extracted.tags.into_iter().map(|tag| StoredTag {
				path: tag.path,
				name: tag.name,
				kind: match tag.kind {
					CodeIntelTagKind::Def => "def".to_string(),
					CodeIntelTagKind::Ref => "ref".to_string(),
				},
				grammar: tag.grammar,
				start_line: tag.start_line,
				end_line: tag.end_line,
			}));
			calls.extend(extracted.calls.into_iter().map(|call| StoredCall {
				path: call.path,
				callee: call.callee,
				start_line: call.start_line,
				end_line: call.end_line,
			}));
		}

		write_jsonl(dest.join("files.jsonl"), &stored_files)?;
		write_jsonl(dest.join("tags.jsonl"), &tags)?;
		write_jsonl(dest.join("chunks.jsonl"), &chunks)?;
		write_jsonl(dest.join("calls.jsonl"), &calls)?;
		let graph_bytes = write_graph_csr(dest.join("graph.csr"), &tags)?;
		let tags_json = serde_json::to_vec(&tags).unwrap_or_default();
		let chunks_json = serde_json::to_vec(&chunks).unwrap_or_default();
		let manifest = Manifest {
			version: MANIFEST_VERSION,
			root,
			git_head: None,
			embedding_model: None,
			dim: 0,
			file_count: stored_files.len() as u32,
			tag_count: tags.len() as u32,
			chunk_count: chunks.len() as u32,
			tags_hash: content_hash(&tags_json),
			chunks_hash: content_hash(&chunks_json),
			embeddings_rows: 0,
			embeddings_dim: 0,
			graph_hash: content_hash(&graph_bytes),
		};
		let manifest_path = dest.join("manifest.json");
		fs::write(
			&manifest_path,
			serde_json::to_vec_pretty(&manifest).map_err(|err| Error::from_reason(err.to_string()))?,
		)
		.map_err(|err| Error::from_reason(format!("write manifest: {err}")))?;

		Ok(CodeIntelBuildResult {
			files_scanned,
			tag_count: tags.len() as u32,
			chunk_count: chunks.len() as u32,
			parse_errors,
		})
	})
}

/// Rank a previously built generation by personalized PageRank. Native holds the graph.
#[napi]
pub fn code_intel_rank_generation(options: CodeIntelRankOptions) -> napi::Result<Vec<CodeIntelRankedNode>> {
	let tags: Vec<StoredTag> = read_jsonl(Path::new(&options.generation_dir).join("tags.jsonl"))?;
	let top_files = options.top_files.unwrap_or(DEFAULT_TOP_FILES) as usize;
	let top_symbols = options.top_symbols.unwrap_or(DEFAULT_TOP_SYMBOLS) as usize;
	Ok(rank_tags(
		&tags,
		options.seed_paths.as_deref().unwrap_or(&[]),
		options.seed_symbols.as_deref().unwrap_or(&[]),
		top_files,
		top_symbols,
	))
}

/// Chunk one file's content using the same def/window rules as generation.
#[napi]
pub fn code_intel_chunk_file(options: CodeIntelChunkOptions) -> Vec<CodeIntelChunk> {
	let lang = SupportLang::from_path(Path::new(&options.path));
	if let Some(lang) = lang {
		if let Ok(extracted) = extract_from_source(&options.path, &options.content, lang) {
			return extracted.chunks;
		}
	}
	chunk_windows(&options.content, &options.path)
}

/// Extract verified call-expression callees from one file.
#[napi]
pub fn code_intel_extract_calls(options: CodeIntelChunkOptions) -> Vec<CodeIntelCall> {
	let Some(lang) = SupportLang::from_path(Path::new(&options.path)) else {
		return Vec::new();
	};
	extract_from_source(&options.path, &options.content, lang)
		.map(|extracted| extracted.calls)
		.unwrap_or_default()
}

fn write_jsonl<T: Serialize>(path: PathBuf, rows: &[T]) -> napi::Result<()> {
	let mut file = File::create(&path).map_err(|err| Error::from_reason(format!("{}: {err}", path.display())))?;
	for row in rows {
		let line = serde_json::to_string(row).map_err(|err| Error::from_reason(err.to_string()))?;
		writeln!(file, "{line}").map_err(|err| Error::from_reason(err.to_string()))?;
	}
	Ok(())
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: PathBuf) -> napi::Result<Vec<T>> {
	let file = File::open(&path).map_err(|err| Error::from_reason(format!("{}: {err}", path.display())))?;
	let reader = BufReader::new(file);
	let mut rows = Vec::new();
	for line in reader.lines() {
		let line = line.map_err(|err| Error::from_reason(err.to_string()))?;
		if line.trim().is_empty() {
			continue;
		}
		rows.push(serde_json::from_str(&line).map_err(|err| Error::from_reason(err.to_string()))?);
	}
	Ok(rows)
}

fn write_graph_csr(path: PathBuf, tags: &[StoredTag]) -> napi::Result<Vec<u8>> {
	let graph = build_graph(tags);
	let mut bytes = Vec::new();
	bytes.extend_from_slice(b"CIGR");
	bytes.extend_from_slice(&(graph.nodes.len() as u32).to_le_bytes());
	bytes.extend_from_slice(&(graph.edges.len() as u32).to_le_bytes());
	for node in &graph.nodes {
		let encoded = node.as_bytes();
		bytes.extend_from_slice(&(encoded.len() as u16).to_le_bytes());
		bytes.extend_from_slice(encoded);
	}
	for &(src, dst) in &graph.edges {
		bytes.extend_from_slice(&src.to_le_bytes());
		bytes.extend_from_slice(&dst.to_le_bytes());
	}
	fs::write(&path, &bytes).map_err(|err| Error::from_reason(format!("{}: {err}", path.display())))?;
	Ok(bytes)
}

struct NameGraph {
	nodes: Vec<String>,
	edges: Vec<(u32, u32)>,
}

fn node_key(path: &str, name: &str) -> String {
	format!("{path}#{name}")
}

fn build_graph(tags: &[StoredTag]) -> NameGraph {
	let mut defs_by_name: HashMap<&str, Vec<&StoredTag>> = HashMap::new();
	let mut node_index: HashMap<String, u32> = HashMap::new();
	let mut nodes = Vec::new();
	for tag in tags {
		if tag.kind != "def" {
			continue;
		}
		defs_by_name.entry(tag.name.as_str()).or_default().push(tag);
		let key = node_key(&tag.path, &tag.name);
		if !node_index.contains_key(&key) {
			node_index.insert(key.clone(), nodes.len() as u32);
			nodes.push(key);
		}
	}
	for tag in tags {
		if tag.kind != "ref" {
			continue;
		}
		let key = node_key(&tag.path, &tag.name);
		if !node_index.contains_key(&key) {
			node_index.insert(key.clone(), nodes.len() as u32);
			nodes.push(key);
		}
	}
	let mut edges = Vec::new();
	for tag in tags {
		if tag.kind != "ref" {
			continue;
		}
		let Some(&src) = node_index.get(&node_key(&tag.path, &tag.name)) else {
			continue;
		};
		if let Some(defs) = defs_by_name.get(tag.name.as_str()) {
			for def in defs {
				if let Some(&dst) = node_index.get(&node_key(&def.path, &def.name))
					&& src != dst
				{
					edges.push((src, dst));
				}
			}
		}
	}
	NameGraph { nodes, edges }
}

fn rank_tags(
	tags: &[StoredTag],
	seed_paths: &[String],
	seed_symbols: &[String],
	top_files: usize,
	top_symbols: usize,
) -> Vec<CodeIntelRankedNode> {
	let graph = build_graph(tags);
	if graph.nodes.is_empty() {
		return Vec::new();
	}
	let n = graph.nodes.len();
	let mut outbound: Vec<Vec<u32>> = vec![Vec::new(); n];
	for &(src, dst) in &graph.edges {
		if (src as usize) < n && (dst as usize) < n {
			outbound[src as usize].push(dst);
		}
	}
	let mut personal = vec![0.0f64; n];
	let seed_path_set: HashSet<&str> = seed_paths.iter().map(String::as_str).collect();
	let seed_symbol_set: HashSet<&str> = seed_symbols.iter().map(String::as_str).collect();
	let mut seed_mass = 0.0;
	for (idx, node) in graph.nodes.iter().enumerate() {
		let Some((path, symbol)) = node.rsplit_once('#') else {
			continue;
		};
		let mut weight = 0.0;
		if seed_path_set.contains(path) {
			weight += 1.0;
		}
		if seed_symbol_set.contains(symbol) {
			weight += 1.0;
		}
		if weight > 0.0 {
			personal[idx] = weight;
			seed_mass += weight;
		}
	}
	if seed_mass == 0.0 {
		for value in &mut personal {
			*value = 1.0 / n as f64;
		}
	} else {
		for value in &mut personal {
			*value /= seed_mass;
		}
	}

	let mut rank = personal.clone();
	for _ in 0..PAGERANK_MAX_ITERS {
		let mut next = vec![0.0f64; n];
		for (src, targets) in outbound.iter().enumerate() {
			if targets.is_empty() {
				let share = rank[src] / n as f64;
				for item in &mut next {
					*item += share;
				}
			} else {
				let share = rank[src] / targets.len() as f64;
				for &dst in targets {
					next[dst as usize] += share;
				}
			}
		}
		let mut delta = 0.0;
		for i in 0..n {
			let value = PAGERANK_DAMPING * next[i] + (1.0 - PAGERANK_DAMPING) * personal[i];
			delta += (value - rank[i]).abs();
			rank[i] = value;
		}
		if delta < PAGERANK_EPSILON {
			break;
		}
	}

	let mut def_span: HashMap<String, (u32, u32)> = HashMap::new();
	for tag in tags {
		if tag.kind == "def" {
			def_span
				.entry(node_key(&tag.path, &tag.name))
				.or_insert((tag.start_line, tag.end_line));
		}
	}

	let mut scored: Vec<(usize, f64)> = rank.into_iter().enumerate().collect();
	scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

	let mut seen_files = HashSet::new();
	let mut out = Vec::new();
	for (idx, score) in scored {
		let Some((path, symbol)) = graph.nodes[idx].rsplit_once('#') else {
			continue;
		};
		let is_new_file = seen_files.insert(path.to_string());
		let file_budget_ok = seen_files.len() <= top_files || !is_new_file;
		if !file_budget_ok && out.len() >= top_symbols {
			continue;
		}
		if out.len() >= top_symbols && seen_files.len() > top_files {
			break;
		}
		let (start_line, end_line) = def_span
			.get(&graph.nodes[idx])
			.copied()
			.unwrap_or((1, 1));
		out.push(CodeIntelRankedNode {
			path: path.to_string(),
			symbol: symbol.to_string(),
			score,
			start_line,
			end_line,
		});
		if out.len() >= top_symbols {
			break;
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn rust_tags_cover_def_and_skip_comment_call() {
		let source = r#"
fn alpha() {
    beta();
}
fn beta() {}
fn gamma() {}
// calls beta
"#;
		let extracted = extract_from_source("lib.rs", source, SupportLang::Rust).expect("extract");
		let defs: Vec<_> = extracted
			.tags
			.iter()
			.filter(|tag| matches!(tag.kind, CodeIntelTagKind::Def))
			.map(|tag| tag.name.as_str())
			.collect();
		assert!(defs.contains(&"alpha"));
		assert!(defs.contains(&"beta"));
		let beta_def = extracted
			.tags
			.iter()
			.find(|tag| tag.name == "beta" && matches!(tag.kind, CodeIntelTagKind::Def))
			.expect("beta def");
		assert_eq!(beta_def.start_line, 5);
		assert!(
			extracted.calls.iter().any(|call| call.callee == "beta"),
			"call-expression resolver must see beta()"
		);
		assert!(
			!extracted.calls.iter().any(|call| call.start_line >= 7),
			"comment must not produce a call edge"
		);
	}

	#[test]
	fn pagerank_seeds_alpha_ranks_beta_above_unrelated() {
		let tags = vec![
			StoredTag {
				path: "a.rs".into(),
				name: "alpha".into(),
				kind: "def".into(),
				grammar: "rust".into(),
				start_line: 1,
				end_line: 3,
			},
			StoredTag {
				path: "a.rs".into(),
				name: "beta".into(),
				kind: "ref".into(),
				grammar: "rust".into(),
				start_line: 2,
				end_line: 2,
			},
			StoredTag {
				path: "b.rs".into(),
				name: "beta".into(),
				kind: "def".into(),
				grammar: "rust".into(),
				start_line: 1,
				end_line: 1,
			},
			StoredTag {
				path: "c.rs".into(),
				name: "unrelated".into(),
				kind: "def".into(),
				grammar: "rust".into(),
				start_line: 1,
				end_line: 1,
			},
		];
		let ranked = rank_tags(&tags, &[], &["alpha".into()], 8, 16);
		let beta = ranked.iter().find(|node| node.symbol == "beta").map(|node| node.score);
		let unrelated = ranked
			.iter()
			.find(|node| node.symbol == "unrelated")
			.map(|node| node.score)
			.unwrap_or(0.0);
		assert!(beta.unwrap_or(0.0) > unrelated);
	}
}
