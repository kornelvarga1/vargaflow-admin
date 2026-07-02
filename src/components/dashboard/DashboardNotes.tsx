import { useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  ListChecks,
  StickyNote,
} from "lucide-react";
import { useUIPreferences } from "@/hooks/useUIPreferences";

const TabIndent = Extension.create({
  name: "tabIndent",
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (this.editor.can().sinkListItem("listItem"))
          return this.editor.chain().sinkListItem("listItem").run();
        if (this.editor.can().sinkListItem("taskItem"))
          return this.editor.chain().sinkListItem("taskItem").run();
        return false;
      },
      "Shift-Tab": () => {
        if (this.editor.can().liftListItem("listItem"))
          return this.editor.chain().liftListItem("listItem").run();
        if (this.editor.can().liftListItem("taskItem"))
          return this.editor.chain().liftListItem("taskItem").run();
        return false;
      },
    };
  },
});

const EXTENSIONS = [
  StarterKit,
  TaskList,
  TaskItem.configure({ nested: true }),
  Placeholder.configure({
    placeholder: "Company directions, daily tasks, anything you need in front of you…",
  }),
  TabIndent,
];

function ToolbarBtn({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      className={`p-1.5 rounded-md transition-colors ${
        active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
      }`}
    >
      {children}
    </button>
  );
}

export default function DashboardNotes() {
  const { prefs, setPref, isLoading } = useUIPreferences();

  const editor = useEditor({
    extensions: EXTENSIONS,
    editorProps: {
      attributes: {
        class:
          "prose prose-sm dark:prose-invert max-w-none outline-none min-h-[72px] text-sm leading-relaxed",
        lang: "en",
        spellcheck: "false",
      },
    },
    onUpdate({ editor }) {
      const json = editor.isEmpty ? null : editor.getJSON();
      setPref("dashboard_notes", json, 800);
    },
  });

  useEffect(() => {
    if (!editor || isLoading) return;
    const stored = prefs.dashboard_notes;
    if (!stored) return;
    if (typeof stored === "object") {
      editor.commands.setContent(stored as object, false);
    } else if (typeof stored === "string" && stored.trim()) {
      editor.commands.setContent(`<p>${stored}</p>`, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, editor]);

  if (isLoading || !editor) return null;

  return (
    <div className="mt-5 bg-card border border-border/60 rounded-2xl px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          <StickyNote className="w-3.5 h-3.5" strokeWidth={1.5} />
          Notes
        </span>
        <div className="flex items-center gap-0.5">
          <ToolbarBtn
            title="Bold (⌘B)"
            active={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold className="w-3.5 h-3.5" strokeWidth={2} />
          </ToolbarBtn>
          <ToolbarBtn
            title="Italic (⌘I)"
            active={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic className="w-3.5 h-3.5" strokeWidth={2} />
          </ToolbarBtn>
          <div className="w-px h-3.5 bg-border/60 mx-1" />
          <ToolbarBtn
            title="Bullet list"
            active={editor.isActive("bulletList")}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            <List className="w-3.5 h-3.5" strokeWidth={2} />
          </ToolbarBtn>
          <ToolbarBtn
            title="Numbered list"
            active={editor.isActive("orderedList")}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            <ListOrdered className="w-3.5 h-3.5" strokeWidth={2} />
          </ToolbarBtn>
          <ToolbarBtn
            title="Checklist"
            active={editor.isActive("taskList")}
            onClick={() => editor.chain().focus().toggleTaskList().run()}
          >
            <ListChecks className="w-3.5 h-3.5" strokeWidth={2} />
          </ToolbarBtn>
        </div>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
