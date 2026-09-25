//! Code-intelligence tags, name-cooccurrence graph, `PageRank`, chunking,
//! and generation snapshot I/O.
//!
//! Identifier tags are a name graph, not a call graph. Call edges are a
//! separate capture (`call.name`) used only by the call-expression resolver.

use std::{
	collections::{HashMap, HashSet},
	fs::{self, File},
	io::{BufRead, BufReader, BufWriter, Write},
	path::{Path, PathBuf},
	sync::LazyLock,
};

use ast_grep_core::tree_sitter::LanguageExt;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_ast::{SupportLang, parse_cache::parse_cached};
use serde::{Deserialize, Serialize};
use tree_sitter::{Query, QueryCursor, StreamingIterator};
use xxhash_rust::xxh64::Xxh64;

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

// Resource budgets and cancellation granularity for generation builds.
const MAX_GRAPH_EDGES: u64 = 50_000_000;
const GRAPH_HEARTBEAT_TAGS: usize = 4096;
const GRAPH_WRITE_HEARTBEAT_PAIRS: u64 = 65_536;
const JSONL_HEARTBEAT_ROWS: usize = 1024;
const PAGERANK_HEARTBEAT_ITERS: usize = 4;

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

/// Ranked symbol/file node from personalized `PageRank`.
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
	pub root:       String,
	pub hidden:     Option<bool>,
	pub gitignore:  Option<bool>,
	pub max_files:  Option<u32>,
	pub signal:     Option<Unknown<'env>>,
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
	version:         u32,
	root:            String,
	git_head:        Option<String>,
	embedding_model: Option<String>,
	dim:             u32,
	file_count:      u32,
	tag_count:       u32,
	chunk_count:     u32,
	tags_hash:       String,
	chunks_hash:     String,
	embeddings_rows: u32,
	embeddings_dim:  u32,
	graph_hash:      String,
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

const fn tags_query_source(lang: SupportLang) -> Option<&'static str> {
	Some(match lang {
		SupportLang::Rust => {
			r"
(function_item name: (identifier) @definition.function)
(struct_item name: (type_identifier) @definition.class)
(enum_item name: (type_identifier) @definition.class)
(trait_item name: (type_identifier) @definition.class)
(mod_item name: (identifier) @definition.module)
(impl_item type: (type_identifier) @definition.class)
(identifier) @reference.identifier
(type_identifier) @reference.identifier
"
		},
		SupportLang::TypeScript | SupportLang::Tsx => {
			r"
(function_declaration name: (identifier) @definition.function)
(generator_function_declaration name: (identifier) @definition.function)
(class_declaration name: (type_identifier) @definition.class)
(method_definition name: (property_identifier) @definition.method)
(interface_declaration name: (type_identifier) @definition.class)
(type_alias_declaration name: (type_identifier) @definition.class)
(identifier) @reference.identifier
(type_identifier) @reference.identifier
(property_identifier) @reference.identifier
"
		},
		SupportLang::JavaScript => {
			r"
(function_declaration name: (identifier) @definition.function)
(generator_function_declaration name: (identifier) @definition.function)
(class_declaration name: (identifier) @definition.class)
(method_definition name: (property_identifier) @definition.method)
(identifier) @reference.identifier
(property_identifier) @reference.identifier
"
		},
		SupportLang::Python => {
			r"
(function_definition name: (identifier) @definition.function)
(class_definition name: (identifier) @definition.class)
(identifier) @reference.identifier
"
		},
		SupportLang::Go => {
			r"
(function_declaration name: (identifier) @definition.function)
(method_declaration name: (field_identifier) @definition.method)
(type_spec name: (type_identifier) @definition.class)
(identifier) @reference.identifier
(field_identifier) @reference.identifier
(type_identifier) @reference.identifier
"
		},
		SupportLang::Java => {
			r"
(method_declaration name: (identifier) @definition.method)
(class_declaration name: (identifier) @definition.class)
(interface_declaration name: (identifier) @definition.class)
(identifier) @reference.identifier
"
		},
		SupportLang::C => {
			r"
(function_definition
  declarator: (function_declarator declarator: (identifier) @definition.function))
(struct_specifier name: (type_identifier) @definition.class)
(identifier) @reference.identifier
(type_identifier) @reference.identifier
"
		},
		SupportLang::Cpp => {
			r"
(function_definition
  declarator: (function_declarator declarator: (identifier) @definition.function))
(function_definition
  declarator: (function_declarator
    declarator: (qualified_identifier (identifier) @definition.function)))
(class_specifier name: (type_identifier) @definition.class)
(struct_specifier name: (type_identifier) @definition.class)
(identifier) @reference.identifier
(type_identifier) @reference.identifier
"
		},
		_ => return None,
	})
}

const fn calls_query_source(lang: SupportLang) -> Option<&'static str> {
	Some(match lang {
		SupportLang::Rust => {
			r"
(call_expression function: (identifier) @call.name)
(call_expression function: (field_expression field: (field_identifier) @call.name))
"
		},
		SupportLang::TypeScript | SupportLang::Tsx | SupportLang::JavaScript => {
			r"
(call_expression function: (identifier) @call.name)
(call_expression function: (member_expression property: (property_identifier) @call.name))
"
		},
		SupportLang::Python => {
			r"
(call function: (identifier) @call.name)
(call function: (attribute attribute: (identifier) @call.name))
"
		},
		SupportLang::Go => {
			r"
(call_expression function: (identifier) @call.name)
(call_expression function: (selector_expression field: (field_identifier) @call.name))
"
		},
		SupportLang::Java => {
			r"
(method_invocation name: (identifier) @call.name)
"
		},
		SupportLang::C | SupportLang::Cpp => {
			r"
(call_expression function: (identifier) @call.name)
(call_expression function: (field_expression field: (field_identifier) @call.name))
"
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

fn extract_from_source(
	path: &str,
	source: &str,
	lang: SupportLang,
) -> std::result::Result<FileExtraction, String> {
	let Some(compiled) = compile_queries(lang) else {
		return Ok(FileExtraction {
			tags:   Vec::new(),
			calls:  Vec::new(),
			chunks: chunk_windows(source, path),
		});
	};
	let tree = parse_cached(source, lang).map_err(|err| err.to_string())?;
	let Some(tree) = tree else {
		return Ok(FileExtraction {
			tags:   Vec::new(),
			calls:  Vec::new(),
			chunks: chunk_windows(source, path),
		});
	};
	let root = tree.root_node();
	let starts = line_starts(source);
	let bytes = source.as_bytes();
	let grammar = lang.canonical_name().to_string();

	let mut defs: Vec<CodeIntelTag> = Vec::new();
	let mut refs: Vec<CodeIntelTag> = Vec::new();
	let mut def_name_spans: HashSet<(u32, u32, String)> = HashSet::new();
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
			let name_start = line_of(node.start_byte(), &starts);
			let name_end = line_of(node.end_byte().saturating_sub(1), &starts).max(name_start);
			if name.starts_with("definition.") {
				def_name_spans.insert((name_start, name_end, text.clone()));
				let def_node = enclosing_definition_node(node);
				let start_line = line_of(def_node.start_byte(), &starts);
				let end_line = line_of(def_node.end_byte().saturating_sub(1), &starts).max(start_line);
				defs.push(CodeIntelTag {
					path: path.to_string(),
					name: text,
					kind: CodeIntelTagKind::Def,
					grammar: grammar.clone(),
					start_line,
					end_line,
				});
			} else {
				refs.push(CodeIntelTag {
					path:       path.to_string(),
					name:       text,
					kind:       CodeIntelTagKind::Ref,
					grammar:    grammar.clone(),
					start_line: name_start,
					end_line:   name_end,
				});
			}
		}
	}

	let refs = refs
		.into_iter()
		.filter(|tag| !def_name_spans.contains(&(tag.start_line, tag.end_line, tag.name.clone())))
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

const DEFINITION_NODE_KINDS: &[&str] = &[
	"function_item",
	"struct_item",
	"enum_item",
	"trait_item",
	"mod_item",
	"impl_item",
	"function_declaration",
	"generator_function_declaration",
	"class_declaration",
	"method_definition",
	"interface_declaration",
	"type_alias_declaration",
	"function_definition",
	"class_definition",
	"method_declaration",
	"type_spec",
	"class_specifier",
	"struct_specifier",
];

fn enclosing_definition_node(node: tree_sitter::Node<'_>) -> tree_sitter::Node<'_> {
	let mut current = node;
	while let Some(parent) = current.parent() {
		if DEFINITION_NODE_KINDS.contains(&parent.kind()) {
			return parent;
		}
		current = parent;
	}
	node
}

fn window_ranges(from: u32, to: u32) -> Vec<(u32, u32)> {
	if from == 0 || to < from {
		return Vec::new();
	}
	let mut ranges = Vec::new();
	let mut start = from;
	let step = CHUNK_WINDOW.saturating_sub(CHUNK_OVERLAP).max(1);
	while start <= to {
		let end = start.saturating_add(CHUNK_WINDOW.saturating_sub(1)).min(to);
		if end < start {
			break;
		}
		let range = (start, end);
		if ranges.last() == Some(&range) {
			break;
		}
		ranges.push(range);
		if end == to {
			break;
		}
		let next = start.saturating_add(step);
		if next <= start {
			let advanced = end.saturating_add(1);
			if advanced <= start {
				break;
			}
			start = advanced;
		} else {
			start = next;
		}
	}
	ranges
}

fn chunk_from_defs(source: &str, _path: &str, defs: &[CodeIntelTag]) -> Vec<CodeIntelChunk> {
	if defs.is_empty() {
		return chunk_windows(source, "");
	}
	let lines: Vec<&str> = source.lines().collect();
	if lines.is_empty() {
		return Vec::new();
	}
	let total = lines.len() as u32;
	let mut chunks = Vec::new();
	let mut covered = vec![false; lines.len()];
	let mut seen: HashSet<(u32, u32, String, String)> = HashSet::new();
	for def in defs {
		let start = def.start_line.max(1).min(total);
		let end = def.end_line.max(start).min(total);
		if start > total {
			continue;
		}
		for line in start..=end {
			if let Some(flag) = covered.get_mut((line - 1) as usize) {
				*flag = true;
			}
		}
		let span_len = end.saturating_sub(start).saturating_add(1);
		let ranges = if span_len <= CHUNK_MAX_DEF_LINES {
			vec![(start, end)]
		} else {
			window_ranges(start, end)
		};
		for (chunk_start, chunk_end) in ranges {
			if !seen.insert((chunk_start, chunk_end, def.name.clone(), "def".to_string())) {
				continue;
			}
			chunks.push(CodeIntelChunk {
				start_line: chunk_start,
				end_line:   chunk_end,
				symbol:     def.name.clone(),
				kind:       "def".to_string(),
				text:       slice_lines(&lines, chunk_start, chunk_end),
			});
		}
	}
	let mut idx = 1u32;
	while idx <= total {
		if covered.get((idx - 1) as usize).copied().unwrap_or(false) {
			idx += 1;
			continue;
		}
		let run_start = idx;
		let mut run_end = idx;
		while run_end < total && !covered.get(run_end as usize).copied().unwrap_or(false) {
			run_end += 1;
		}
		for (chunk_start, chunk_end) in window_ranges(run_start, run_end) {
			if !seen.insert((chunk_start, chunk_end, String::new(), "window".to_string())) {
				continue;
			}
			chunks.push(CodeIntelChunk {
				start_line: chunk_start,
				end_line:   chunk_end,
				symbol:     String::new(),
				kind:       "window".to_string(),
				text:       slice_lines(&lines, chunk_start, chunk_end),
			});
		}
		idx = run_end.saturating_add(1);
	}
	chunks
}

fn chunk_windows(source: &str, _path: &str) -> Vec<CodeIntelChunk> {
	let lines: Vec<&str> = source.lines().collect();
	if lines.is_empty() {
		return Vec::new();
	}
	window_ranges(1, lines.len() as u32)
		.into_iter()
		.map(|(start, end)| CodeIntelChunk {
			start_line: start,
			end_line:   end,
			symbol:     String::new(),
			kind:       "window".to_string(),
			text:       slice_lines(&lines, start, end),
		})
		.collect()
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

type ExtractedTree = (Vec<FileExtraction>, u32, Vec<String>, Vec<StoredFile>);

fn extract_tree(
	root: &Path,
	hidden: bool,
	gitignore: bool,
	max_files: usize,
	ct: &task::CancelToken,
) -> napi::Result<ExtractedTree> {
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
					path:         display,
					mtime_ms:     metadata
						.as_ref()
						.and_then(|meta| meta.modified().ok())
						.and_then(|time| {
							time
								.duration_since(std::time::UNIX_EPOCH)
								.ok()
								.map(|d| d.as_secs_f64() * 1000.0)
						})
						.unwrap_or(0.0),
					size:         metadata
						.as_ref()
						.map_or(source.len() as u64, |meta| meta.len()),
					content_hash: content_hash(source.as_bytes()),
					tag_count:    extracted.tags.len() as u32,
					chunk_ids:    Vec::new(),
				});
				extractions.push(extracted);
			},
			Err(err) => parse_errors.push(format!("{display}: {err}")),
		}
	}
	Ok((extractions, scanned, parse_errors, stored_files))
}

/// Extract tags and call-expressions from a file or directory (tests /
/// diagnostics).
#[napi]
pub fn code_intel_extract_tags(
	options: CodeIntelExtractOptions<'_>,
) -> task::Promise<CodeIntelExtractResult> {
	let CodeIntelExtractOptions { root, hidden, gitignore, max_files, signal, timeout_ms } = options;
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
			ct.heartbeat()?;
			tags.extend(extracted.tags);
			calls.extend(extracted.calls);
		}
		Ok(CodeIntelExtractResult { tags, calls, files_scanned, parse_errors })
	})
}

/// Build a generation directory: files/tags/chunks/graph. Does not write
/// embeddings.
#[napi]
pub fn code_intel_build_generation(
	options: CodeIntelBuildOptions<'_>,
) -> task::Promise<CodeIntelBuildResult> {
	let CodeIntelBuildOptions { root, dest_dir, hidden, gitignore, max_files, signal, timeout_ms } =
		options;
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
			ct.heartbeat()?;
			let mut ids = Vec::new();
			for chunk in extracted.chunks {
				ids.push(chunk_id);
				chunks.push(StoredChunk {
					id:           chunk_id,
					path:         file.path.clone(),
					start_line:   chunk.start_line,
					end_line:     chunk.end_line,
					symbol:       chunk.symbol,
					kind:         chunk.kind,
					text_hash:    content_hash(chunk.text.as_bytes()),
					content_hash: file.content_hash.clone(),
				});
				chunk_id += 1;
			}
			file.chunk_ids = ids;
			tags.extend(extracted.tags.into_iter().map(|tag| StoredTag {
				path:       tag.path,
				name:       tag.name,
				kind:       match tag.kind {
					CodeIntelTagKind::Def => "def".to_string(),
					CodeIntelTagKind::Ref => "ref".to_string(),
				},
				grammar:    tag.grammar,
				start_line: tag.start_line,
				end_line:   tag.end_line,
			}));
			calls.extend(extracted.calls.into_iter().map(|call| StoredCall {
				path:       call.path,
				callee:     call.callee,
				start_line: call.start_line,
				end_line:   call.end_line,
			}));
		}

		write_jsonl(dest.join("files.jsonl"), &stored_files, &ct)?;
		write_jsonl(dest.join("tags.jsonl"), &tags, &ct)?;
		write_jsonl(dest.join("chunks.jsonl"), &chunks, &ct)?;
		write_jsonl(dest.join("calls.jsonl"), &calls, &ct)?;
		let graph_hash = write_graph_csr(dest.join("graph.csr"), &tags, &ct, MAX_GRAPH_EDGES)?;
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
			graph_hash,
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

/// Rank a previously built generation by personalized `PageRank`. Native holds
/// the graph.
#[napi]
pub fn code_intel_rank_generation(
	options: CodeIntelRankOptions,
) -> napi::Result<Vec<CodeIntelRankedNode>> {
	let tags: Vec<StoredTag> = read_jsonl(Path::new(&options.generation_dir).join("tags.jsonl"))?;
	let top_files = options.top_files.unwrap_or(DEFAULT_TOP_FILES) as usize;
	let top_symbols = options.top_symbols.unwrap_or(DEFAULT_TOP_SYMBOLS) as usize;
	rank_tags(
		&tags,
		options.seed_paths.as_deref().unwrap_or(&[]),
		options.seed_symbols.as_deref().unwrap_or(&[]),
		top_files,
		top_symbols,
		&task::CancelToken::default(),
	)
}

/// Chunk one file's content using the same def/window rules as generation.
#[napi]
pub fn code_intel_chunk_file(options: CodeIntelChunkOptions) -> Vec<CodeIntelChunk> {
	let lang = SupportLang::from_path(Path::new(&options.path));
	if let Some(lang) = lang
		&& let Ok(extracted) = extract_from_source(&options.path, &options.content, lang)
	{
		return extracted.chunks;
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

fn write_jsonl<T: Serialize>(
	path: PathBuf,
	rows: &[T],
	ct: &task::CancelToken,
) -> napi::Result<()> {
	ct.heartbeat()?;
	let file = File::create(&path)
		.map_err(|err| Error::from_reason(format!("{}: {err}", path.display())))?;
	let mut writer = BufWriter::new(file);
	for (idx, row) in rows.iter().enumerate() {
		if idx % JSONL_HEARTBEAT_ROWS == 0 {
			ct.heartbeat()?;
		}
		let line = serde_json::to_string(row).map_err(|err| Error::from_reason(err.to_string()))?;
		writeln!(writer, "{line}").map_err(|err| Error::from_reason(err.to_string()))?;
	}
	writer
		.flush()
		.map_err(|err| Error::from_reason(format!("{}: {err}", path.display())))?;
	Ok(())
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: PathBuf) -> napi::Result<Vec<T>> {
	let file =
		File::open(&path).map_err(|err| Error::from_reason(format!("{}: {err}", path.display())))?;
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

fn write_hashed(writer: &mut impl Write, hasher: &mut Xxh64, bytes: &[u8]) -> napi::Result<()> {
	writer
		.write_all(bytes)
		.map_err(|err| Error::from_reason(err.to_string()))?;
	hasher.update(bytes);
	Ok(())
}

/// Stream `graph.csr` in the existing CIGR format (magic, node count, edge
/// count, node strings, then src/dst u32 pairs) without materializing the
/// full edge list in memory. Duplicate occurrences are expanded back into
/// individual pairs so the on-disk format and `PageRank` weight semantics are
/// unchanged; the returned value is the content hash of the exact bytes
/// written (streamed, so hashing costs no extra memory). `max_edges` is
/// enforced by the shared `build_graph` before any (ref, def) pair is
/// enumerated, so over-budget builds are rejected here before a file is
/// created.
fn write_graph_csr(
	path: PathBuf,
	tags: &[StoredTag],
	ct: &task::CancelToken,
	max_edges: u64,
) -> napi::Result<String> {
	let graph = build_graph(tags, ct, max_edges)?;
	let edge_count = graph.total_weight;
	let Ok(edge_count) = u32::try_from(edge_count) else {
		return Err(Error::from_reason(
			"graph edge count exceeds u32; generation too large".to_string(),
		));
	};
	ct.heartbeat()?;
	let file = File::create(&path)
		.map_err(|err| Error::from_reason(format!("{}: {err}", path.display())))?;
	let mut writer = BufWriter::new(file);
	let mut hasher = Xxh64::new(HASH_SEED);
	let mut header = Vec::with_capacity(12);
	header.extend_from_slice(b"CIGR");
	header.extend_from_slice(&(graph.nodes.len() as u32).to_le_bytes());
	header.extend_from_slice(&edge_count.to_le_bytes());
	write_hashed(&mut writer, &mut hasher, &header)?;
	for node in &graph.nodes {
		let encoded = node.as_bytes();
		write_hashed(&mut writer, &mut hasher, &(encoded.len() as u16).to_le_bytes())?;
		write_hashed(&mut writer, &mut hasher, encoded)?;
	}
	let mut pair = [0u8; 8];
	let mut expanded = 0u64;
	for &(src, dst, weight) in &graph.edges {
		for _ in 0..weight {
			pair[..4].copy_from_slice(&src.to_le_bytes());
			pair[4..].copy_from_slice(&dst.to_le_bytes());
			write_hashed(&mut writer, &mut hasher, &pair)?;
			expanded += 1;
			if expanded.is_multiple_of(GRAPH_WRITE_HEARTBEAT_PAIRS) {
				ct.heartbeat()?;
			}
		}
	}
	writer
		.flush()
		.map_err(|err| Error::from_reason(format!("{}: {err}", path.display())))?;
	Ok(format!("{:016x}", hasher.digest()))
}

struct NameGraph {
	nodes:        Vec<String>,
	/// Occurrence-weighted unique (src, dst) pairs in deterministic
	/// first-occurrence order. `weight` counts every (ref, def) occurrence
	/// mapped to this pair, so `PageRank` sees exactly the multi-reference
	/// weight of the un-merged expansion while memory stays bounded by unique
	/// pairs (no refs-per-name × defs-per-name blowup).
	edges:        Vec<(u32, u32, u32)>,
	/// Raw expanded edge count (sum of weights); used for the build budget.
	total_weight: u64,
}

fn node_key(path: &str, name: &str) -> String {
	format!("{path}#{name}")
}

fn build_graph(
	tags: &[StoredTag],
	ct: &task::CancelToken,
	max_edges: u64,
) -> napi::Result<NameGraph> {
	ct.heartbeat()?;
	let mut defs_by_name: HashMap<&str, Vec<&StoredTag>> = HashMap::new();
	let mut ref_count: HashMap<&str, u64> = HashMap::new();
	let mut node_index: HashMap<String, u32> = HashMap::new();
	let mut nodes = Vec::new();
	for (idx, tag) in tags.iter().enumerate() {
		if idx % GRAPH_HEARTBEAT_TAGS == 0 {
			ct.heartbeat()?;
		}
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
	for (idx, tag) in tags.iter().enumerate() {
		if idx % GRAPH_HEARTBEAT_TAGS == 0 {
			ct.heartbeat()?;
		}
		if tag.kind != "ref" {
			continue;
		}
		*ref_count.entry(tag.name.as_str()).or_default() += 1;
		let key = node_key(&tag.path, &tag.name);
		if !node_index.contains_key(&key) {
			node_index.insert(key.clone(), nodes.len() as u32);
			nodes.push(key);
		}
	}
	// Budget gate before any (ref, def) pair is enumerated. An upper bound of
	// the expanded edge count is sum over names of refs(name) * def_tags(name);
	// it also covers candidate self-edges the src != dst filter later drops,
	// so the real count is always <= this bound. Products and the running
	// total use checked arithmetic; overflow means the graph is far beyond any
	// buildable size and is rejected explicitly. Enumerating pairs only after
	// this gate bounds both time and the unique-pair map by `max_edges`, which
	// also protects the rank path (build_graph is shared).
	let mut putative_total: u64 = 0;
	for (name, refs) in &ref_count {
		let Some(defs) = defs_by_name.get(*name) else {
			continue;
		};
		let product = refs.checked_mul(defs.len() as u64).ok_or_else(|| {
			Error::from_reason(format!(
				"graph edge budget exceeded: refs x defs for '{name}' overflows"
			))
		})?;
		putative_total = putative_total.checked_add(product).ok_or_else(|| {
			Error::from_reason("graph edge budget exceeded: expanded edge count overflows".to_string())
		})?;
	}
	if putative_total > max_edges {
		return Err(Error::from_reason(format!(
			"graph edge budget exceeded: up to {putative_total} candidate edges > limit {max_edges}; \
			 generation too large to build reliably"
		)));
	}
	let mut edges: Vec<(u32, u32, u32)> = Vec::new();
	let mut edge_pos: HashMap<(u32, u32), usize> = HashMap::new();
	let mut total_weight: u64 = 0;
	for (idx, tag) in tags.iter().enumerate() {
		if idx % GRAPH_HEARTBEAT_TAGS == 0 {
			ct.heartbeat()?;
		}
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
					// Bounded by the budget gate above, so plain accumulation
					// is exact and cannot overflow.
					total_weight += 1;
					if let Some(&pos) = edge_pos.get(&(src, dst)) {
						edges[pos].2 += 1;
					} else {
						edge_pos.insert((src, dst), edges.len());
						edges.push((src, dst, 1));
					}
				}
			}
		}
	}
	Ok(NameGraph { nodes, edges, total_weight })
}

/// Weighted `PageRank`: node rank flows in proportion to `weight / total
/// weight`, which reproduces the multi-edge semantics of the un-merged
/// adjacency exactly (each (ref, def) occurrence moves the same unit of
/// rank) while keeping memory proportional to unique edges. Dangling nodes
/// are folded into one uniform share instead of an O(n) sprinkle per node,
/// bounding each iteration at O(n + edges).
fn pagerank_rank(
	outbound: &[Vec<(u32, u32)>],
	n: usize,
	personal: &[f64],
	ct: &task::CancelToken,
) -> napi::Result<Vec<f64>> {
	ct.heartbeat()?;
	let mut outbound_total = vec![0u64; n];
	for (src, targets) in outbound.iter().enumerate() {
		for &(_, weight) in targets {
			outbound_total[src] += u64::from(weight);
		}
	}
	let mut rank = personal.to_vec();
	for iter in 0..PAGERANK_MAX_ITERS {
		if iter % PAGERANK_HEARTBEAT_ITERS == 0 {
			ct.heartbeat()?;
		}
		let mut next = vec![0.0f64; n];
		let mut dangling_sum = 0.0;
		for (src, targets) in outbound.iter().enumerate() {
			if targets.is_empty() {
				dangling_sum += rank[src];
				continue;
			}
			let share = rank[src] / outbound_total[src] as f64;
			for &(dst, weight) in targets {
				next[dst as usize] = share.mul_add(f64::from(weight), next[dst as usize]);
			}
		}
		if dangling_sum > 0.0 {
			let dangling_share = dangling_sum / n as f64;
			for item in &mut next {
				*item += dangling_share;
			}
		}
		let mut delta = 0.0;
		for i in 0..n {
			let value = (1.0 - PAGERANK_DAMPING).mul_add(personal[i], PAGERANK_DAMPING * next[i]);
			delta += (value - rank[i]).abs();
			rank[i] = value;
		}
		if delta < PAGERANK_EPSILON {
			break;
		}
	}
	ct.heartbeat()?;
	Ok(rank)
}

fn rank_tags(
	tags: &[StoredTag],
	seed_paths: &[String],
	seed_symbols: &[String],
	top_files: usize,
	top_symbols: usize,
	ct: &task::CancelToken,
) -> napi::Result<Vec<CodeIntelRankedNode>> {
	let graph = build_graph(tags, ct, MAX_GRAPH_EDGES)?;
	if graph.nodes.is_empty() {
		return Ok(Vec::new());
	}
	let n = graph.nodes.len();
	let mut outbound: Vec<Vec<(u32, u32)>> = vec![Vec::new(); n];
	for &(src, dst, weight) in &graph.edges {
		if (src as usize) < n && (dst as usize) < n {
			outbound[src as usize].push((dst, weight));
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

	let rank = pagerank_rank(&outbound, n, &personal, ct)?;

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
		let (start_line, end_line) = def_span.get(&graph.nodes[idx]).copied().unwrap_or((1, 1));
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
	Ok(out)
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
				path:       "a.rs".into(),
				name:       "alpha".into(),
				kind:       "def".into(),
				grammar:    "rust".into(),
				start_line: 1,
				end_line:   3,
			},
			StoredTag {
				path:       "a.rs".into(),
				name:       "beta".into(),
				kind:       "ref".into(),
				grammar:    "rust".into(),
				start_line: 2,
				end_line:   2,
			},
			StoredTag {
				path:       "b.rs".into(),
				name:       "beta".into(),
				kind:       "def".into(),
				grammar:    "rust".into(),
				start_line: 1,
				end_line:   1,
			},
			StoredTag {
				path:       "c.rs".into(),
				name:       "unrelated".into(),
				kind:       "def".into(),
				grammar:    "rust".into(),
				start_line: 1,
				end_line:   1,
			},
		];
		let ranked = rank_tags(&tags, &[], &["alpha".into()], 8, 16, &task::CancelToken::default())
			.expect("rank");
		let beta = ranked
			.iter()
			.find(|node| node.symbol == "beta")
			.map(|node| node.score);
		let unrelated = ranked
			.iter()
			.find(|node| node.symbol == "unrelated")
			.map(|node| node.score)
			.unwrap_or(0.0);
		assert!(beta.unwrap_or(0.0) > unrelated);
	}

	#[test]
	fn rust_multiline_def_chunk_contains_body() {
		let source = r#"
fn alpha() {
    let value = 41;
    beta();
}
fn beta() {}
"#;
		let extracted = extract_from_source("lib.rs", source, SupportLang::Rust).expect("extract");
		let alpha_def = extracted
			.tags
			.iter()
			.find(|tag| tag.name == "alpha" && matches!(tag.kind, CodeIntelTagKind::Def))
			.expect("alpha def");
		assert_eq!(alpha_def.start_line, 2);
		assert!(alpha_def.end_line >= 4);
		assert!(
			!extracted.tags.iter().any(|tag| {
				tag.name == "alpha"
					&& matches!(tag.kind, CodeIntelTagKind::Ref)
					&& tag.start_line == 2
					&& tag.end_line == 2
			}),
			"definition identifier must not be duplicated as a ref"
		);

		let alpha_chunk = extracted
			.chunks
			.iter()
			.find(|chunk| chunk.symbol == "alpha" && chunk.kind == "def")
			.expect("alpha chunk");
		assert!(alpha_chunk.text.contains("let value = 41"));
		assert!(alpha_chunk.text.contains("beta()"));
		assert_eq!(alpha_chunk.start_line, alpha_def.start_line);
		assert_eq!(alpha_chunk.end_line, alpha_def.end_line);
	}
	#[test]
	fn first_batch_languages_extract_definition_bodies() {
		let fixtures = [
			("alpha.ts", "function alpha() {\n  return 1;\n}\n", SupportLang::TypeScript),
			("alpha.tsx", "function alpha() {\n  return 1;\n}\n", SupportLang::Tsx),
			("alpha.js", "function alpha() {\n  return 1;\n}\n", SupportLang::JavaScript),
			("alpha.py", "def alpha():\n    return 1\n", SupportLang::Python),
			("alpha.go", "func alpha() {\n}\n", SupportLang::Go),
			("Alpha.java", "class Alpha {\n  void alpha() {\n  }\n}\n", SupportLang::Java),
			("alpha.c", "int alpha() {\n  return 1;\n}\n", SupportLang::C),
			("alpha.cpp", "int alpha() {\n  return 1;\n}\n", SupportLang::Cpp),
		];
		for (path, source, lang) in fixtures {
			let extracted =
				extract_from_source(path, source, lang).unwrap_or_else(|err| panic!("{path}: {err}"));
			let alpha = extracted
				.tags
				.iter()
				.find(|tag| tag.name == "alpha" && matches!(tag.kind, CodeIntelTagKind::Def))
				.unwrap_or_else(|| panic!("{path}: alpha definition missing"));
			assert!(alpha.end_line > alpha.start_line, "{path}: definition body span missing");
			let chunk = extracted
				.chunks
				.iter()
				.find(|chunk| chunk.symbol == "alpha")
				.unwrap_or_else(|| panic!("{path}: alpha chunk missing"));
			assert!(chunk.end_line > chunk.start_line, "{path}: definition body chunk missing");
		}
	}

	#[test]
	fn no_definition_file_uses_overlapping_windows() {
		let source = (1..=120)
			.map(|line| format!("// line-{line}"))
			.collect::<Vec<_>>()
			.join("\n");
		let extracted = extract_from_source("lib.rs", &source, SupportLang::Rust).expect("extract");
		assert!(
			extracted
				.tags
				.iter()
				.all(|tag| !matches!(tag.kind, CodeIntelTagKind::Def))
		);
		let ranges: Vec<(u32, u32)> = extracted
			.chunks
			.iter()
			.map(|chunk| (chunk.start_line, chunk.end_line))
			.collect();
		assert_eq!(ranges, vec![(1, 80), (41, 120)]);
	}

	fn tag(path: &str, name: &str, kind: &str) -> StoredTag {
		StoredTag {
			path:       path.into(),
			name:       name.into(),
			kind:       kind.into(),
			grammar:    "rust".into(),
			start_line: 1,
			end_line:   1,
		}
	}

	/// Reference replica of the pre-optimization expansion: one unweighted
	/// edge per (ref, def) occurrence, duplicates included.
	fn build_graph_raw(tags: &[StoredTag]) -> (Vec<String>, Vec<(u32, u32)>) {
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
		(nodes, edges)
	}

	fn expand_weighted(graph: &NameGraph) -> Vec<(u32, u32)> {
		let mut out = Vec::new();
		for &(src, dst, weight) in &graph.edges {
			for _ in 0..weight {
				out.push((src, dst));
			}
		}
		out
	}

	#[test]
	fn weighted_graph_matches_raw_edge_expansion() {
		let tags = vec![
			tag("a.rs", "hot", "def"),
			tag("a.rs", "hot", "ref"),
			tag("a.rs", "hot", "ref"),
			tag("b.rs", "hot", "def"),
			tag("b.rs", "hot", "def"),
			tag("c.rs", "hot", "ref"),
			tag("c.rs", "hot", "ref"),
			tag("c.rs", "hot", "ref"),
			tag("c.rs", "cold", "def"),
			tag("a.rs", "cold", "ref"),
		];
		let ct = task::CancelToken::default();
		let graph = build_graph(&tags, &ct, 100).expect("build");
		let (raw_nodes, raw_edges) = build_graph_raw(&tags);
		assert_eq!(graph.nodes, raw_nodes, "node identity and order must be unchanged");
		assert_eq!(graph.total_weight, raw_edges.len() as u64, "expanded edge count");
		let expanded = expand_weighted(&graph);
		assert_eq!(expanded.len(), raw_edges.len());
		let mut count: HashMap<(u32, u32), i64> = HashMap::new();
		for pair in &expanded {
			*count.entry(*pair).or_default() += 1;
		}
		for pair in &raw_edges {
			*count.entry(*pair).or_default() -= 1;
		}
		assert!(
			count.values().all(|&v| v == 0),
			"weighted merge must preserve every (ref, def) occurrence: {count:?}"
		);
	}

	#[test]
	fn duplicate_defs_in_one_file_keep_multi_reference_weight() {
		let tags = vec![
			tag("a.rs", "dup", "def"),
			tag("a.rs", "dup", "def"),
			tag("b.rs", "dup", "def"),
			tag("c.rs", "dup", "ref"),
			tag("c.rs", "dup", "ref"),
			tag("c.rs", "dup", "ref"),
		];
		let ct = task::CancelToken::default();
		let graph = build_graph(&tags, &ct, 100).expect("build");
		// a.rs defines dup twice targeting the same node, so every ref to dup
		// expands to two occurrences of the same (src, dst) pair. Simple
		// unique-dst dedupe would halve this weight and change PageRank.
		let a_idx = graph.nodes.iter().position(|n| n == "a.rs#dup").unwrap() as u32;
		let b_idx = graph.nodes.iter().position(|n| n == "b.rs#dup").unwrap() as u32;
		let c_idx = graph.nodes.iter().position(|n| n == "c.rs#dup").unwrap() as u32;
		let w_a = graph
			.edges
			.iter()
			.find(|&&(src, dst, _)| src == c_idx && dst == a_idx)
			.map(|&(_, _, w)| w)
			.unwrap_or(0);
		let w_b = graph
			.edges
			.iter()
			.find(|&&(src, dst, _)| src == c_idx && dst == b_idx)
			.map(|&(_, _, w)| w)
			.unwrap_or(0);
		assert_eq!(w_a, 6, "3 refs x 2 def tags in a.rs (same node)");
		assert_eq!(w_b, 3, "3 refs x 1 def tag in b.rs");
		assert_eq!(graph.total_weight, 9);
	}

	#[test]
	fn duplicate_defs_in_one_file_keep_rank_weight_not_deduped() {
		let tags = vec![
			tag("a.rs", "dup", "def"),
			tag("a.rs", "dup", "def"),
			tag("b.rs", "dup", "def"),
			tag("c.rs", "dup", "ref"),
			tag("c.rs", "dup", "ref"),
			tag("c.rs", "dup", "ref"),
		];
		let ct = task::CancelToken::default();
		let ranked = rank_tags(&tags, &["c.rs".into()], &[], 8, 16, &ct).expect("rank");
		let score_a = ranked
			.iter()
			.find(|node| node.path == "a.rs" && node.symbol == "dup")
			.map(|node| node.score)
			.unwrap_or(0.0);
		let score_b = ranked
			.iter()
			.find(|node| node.path == "b.rs" && node.symbol == "dup")
			.map(|node| node.score)
			.unwrap_or(0.0);
		// 3 refs from c.rs split 2/3 toward a.rs and 1/3 toward b.rs; naive
		// dedupe would flatten both to 1/2 and change the ranking.
		assert!(
			score_a > score_b * 1.3,
			"duplicate def weight must survive ranking: a={score_a} b={score_b}"
		);
	}

	#[test]
	fn pagerank_weighted_matches_raw_edge_semantics() {
		let tags = vec![
			tag("x.rs", "mux", "ref"),
			tag("x.rs", "other", "ref"),
			tag("y.rs", "mux", "def"),
			tag("y2.rs", "mux", "def"),
			tag("z.rs", "other", "def"),
			tag("a.rs", "dup", "def"),
			tag("a.rs", "dup", "def"),
			tag("b.rs", "dup", "def"),
			tag("c.rs", "dup", "ref"),
			tag("c.rs", "dup", "ref"),
			tag("c.rs", "dup", "ref"),
		];
		let ct = task::CancelToken::default();
		let graph = build_graph(&tags, &ct, 100).expect("build");
		let n = graph.nodes.len();
		let mut weighted_out: Vec<Vec<(u32, u32)>> = vec![Vec::new(); n];
		for &(src, dst, weight) in &graph.edges {
			weighted_out[src as usize].push((dst, weight));
		}
		// Legacy adjacency: one unweighted entry per occurrence, duplicates
		// included.
		let (_, raw_edges) = build_graph_raw(&tags);
		let mut raw_out: Vec<Vec<(u32, u32)>> = vec![Vec::new(); n];
		for &(src, dst) in &raw_edges {
			raw_out[src as usize].push((dst, 1));
		}
		let personal = vec![1.0 / n as f64; n];
		let weighted_rank = pagerank_rank(&weighted_out, n, &personal, &ct).expect("weighted");
		let raw_rank = pagerank_rank(&raw_out, n, &personal, &ct).expect("raw");
		for (i, (w, r)) in weighted_rank.iter().zip(raw_rank.iter()).enumerate() {
			assert!((w - r).abs() < 1e-9, "node {i}: weighted rank {w} diverges from raw {r}");
		}
	}

	#[test]
	fn pagerank_all_dangling_nodes_stays_uniform() {
		let ct = task::CancelToken::default();
		let n = 4usize;
		let personal = vec![0.25; n];
		let rank = pagerank_rank(&vec![Vec::new(); n], n, &personal, &ct).expect("rank");
		for value in rank {
			assert!(
				(value - 0.25).abs() < 1e-12,
				"uniform teleport expected for fully dangling graph: {value}"
			);
		}
	}

	#[test]
	fn write_jsonl_roundtrips_and_reports_io_errors() {
		let ct = task::CancelToken::default();
		let pid = std::process::id();
		let nanos = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap()
			.as_nanos();
		let dir = std::env::temp_dir().join(format!("omp-ci-jsonl-{pid}-{nanos}"));
		fs::create_dir_all(&dir).expect("mkdir");
		let path = dir.join("tags.jsonl");
		let tags =
			vec![tag("a.rs", "alpha", "def"), tag("b.rs", "beta", "ref"), tag("c.rs", "gamma", "def")];
		write_jsonl(path.clone(), &tags, &ct).expect("write");
		let back = read_jsonl::<StoredTag>(path.clone()).expect("read");
		assert_eq!(back, tags);
		let empty = dir.join("empty.jsonl");
		write_jsonl(empty.clone(), &Vec::<StoredTag>::new(), &ct).expect("write empty");
		assert_eq!(fs::read_to_string(&empty).expect("read empty"), "");
		let missing = dir.join("nope").join("tags.jsonl");
		let err = write_jsonl(missing, &tags, &ct).expect_err("missing parent must fail");
		assert!(err.to_string().contains("nope"), "error must name the path: {err}");
		let mut cancelled = task::CancelToken::default();
		let abort = cancelled.emplace_abort_token();
		abort.abort(task::AbortReason::User);
		let err = write_jsonl(dir.join("cancelled.jsonl"), &tags, &cancelled).expect_err("cancel");
		assert!(err.to_string().contains("Aborted"), "cancellation error: {err}");
		fs::remove_dir_all(&dir).ok();
	}

	#[test]
	fn graph_csr_budget_rejects_and_hash_matches_file_bytes() {
		let ct = task::CancelToken::default();
		let tags = vec![
			tag("a.rs", "dup", "def"),
			tag("a.rs", "dup", "def"),
			tag("b.rs", "dup", "def"),
			tag("c.rs", "dup", "ref"),
			tag("c.rs", "dup", "ref"),
			tag("c.rs", "dup", "ref"),
		];
		let pid = std::process::id();
		let nanos = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap()
			.as_nanos();
		let dir = std::env::temp_dir().join(format!("omp-ci-csr-{pid}-{nanos}"));
		fs::create_dir_all(&dir).expect("mkdir");
		// Total expanded weight is 9 (3 refs x 3 def tags); a 4-edge budget
		// must reject explicitly instead of truncating.
		let err = write_graph_csr(dir.join("too-many.csr"), &tags, &ct, 4)
			.expect_err("over-budget build must fail");
		assert!(err.to_string().contains("budget"), "error must explain the budget: {err}");
		let path_a = dir.join("graph-a.csr");
		let path_b = dir.join("graph-b.csr");
		let hash_a = write_graph_csr(path_a.clone(), &tags, &ct, 100).expect("write a");
		let hash_b = write_graph_csr(path_b.clone(), &tags, &ct, 100).expect("write b");
		assert_eq!(hash_a, hash_b, "identical input must hash identically");
		let bytes = fs::read(&path_a).expect("read csr");
		assert_eq!(&bytes[..4], b"CIGR", "magic preserved");
		assert_eq!(hash_a, content_hash(&bytes), "streamed hash == one-shot hash");
		let node_count = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
		let edge_count = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
		assert_eq!(edge_count, 9, "expanded pairs are written in full");
		let mut cursor = 12usize;
		let mut nodes = Vec::new();
		for _ in 0..node_count {
			let len = u16::from_le_bytes(bytes[cursor..cursor + 2].try_into().unwrap()) as usize;
			cursor += 2;
			nodes.push(String::from_utf8(bytes[cursor..cursor + len].to_vec()).unwrap());
			cursor += len;
		}
		assert_eq!(nodes, vec!["a.rs#dup", "b.rs#dup", "c.rs#dup"]);
		let mut pairs = Vec::new();
		for _ in 0..edge_count {
			let src = u32::from_le_bytes(bytes[cursor..cursor + 4].try_into().unwrap());
			let dst = u32::from_le_bytes(bytes[cursor + 4..cursor + 8].try_into().unwrap());
			pairs.push((src, dst));
			cursor += 8;
		}
		assert_eq!(cursor, bytes.len(), "no trailing bytes");
		let a_idx = nodes.iter().position(|n| n == "a.rs#dup").unwrap() as u32;
		let b_idx = nodes.iter().position(|n| n == "b.rs#dup").unwrap() as u32;
		let c_idx = nodes.iter().position(|n| n == "c.rs#dup").unwrap() as u32;
		assert_eq!(
			pairs
				.iter()
				.filter(|&&(s, d)| s == c_idx && d == a_idx)
				.count(),
			6
		);
		assert_eq!(
			pairs
				.iter()
				.filter(|&&(s, d)| s == c_idx && d == b_idx)
				.count(),
			3
		);
		fs::remove_dir_all(&dir).ok();
	}

	#[test]
	fn build_graph_rejects_over_budget_before_enumeration() {
		let tags = vec![
			tag("a.rs", "dup", "def"),
			tag("a.rs", "dup", "def"),
			tag("b.rs", "dup", "def"),
			tag("c.rs", "dup", "ref"),
			tag("c.rs", "dup", "ref"),
			tag("c.rs", "dup", "ref"),
		];
		let ct = task::CancelToken::default();
		// refs("dup") x def_tags("dup") = 3 x 3 = 9 > 4, so the gate rejects
		// before any unique (src, dst) pair map is allocated; build_graph is
		// shared by build and rank, so this protects both paths.
		let err = build_graph(&tags, &ct, 4)
			.err()
			.expect("over-budget build must fail");
		assert!(err.to_string().contains("budget"), "error must explain the budget: {err}");
		let graph = build_graph(&tags, &ct, 100).expect("within budget");
		assert_eq!(graph.total_weight, 9);
	}

	#[test]
	fn build_graph_respects_cancellation() {
		let tags = vec![tag("a.rs", "hot", "def"), tag("b.rs", "hot", "ref")];
		let mut ct = task::CancelToken::default();
		let abort = ct.emplace_abort_token();
		abort.abort(task::AbortReason::User);
		let err = build_graph(&tags, &ct, 100)
			.err()
			.expect("cancelled build must fail");
		assert!(err.to_string().contains("Aborted"), "cancellation error: {err}");
	}
}
