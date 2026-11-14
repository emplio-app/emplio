"use client";

import { Button } from "@/components/ui/button";
import {
  ButtonGroup,
  ButtonGroupText,
} from "@/components/ui/button-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import type { DiagramPlugin } from "@streamdown/mermaid";
import type { UIMessage } from "ai";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactElement } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { defaultComponents, Streamdown } from "streamdown";
import { ShortLink } from "@/components/chat/highlight";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:w-full group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};

interface MessageBranchContextType {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null
);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error(
      "MessageBranch components must be used within MessageBranch"
    );
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch);
      onBranchChange?.(newBranch);
    },
    [onBranchChange]
  );

  const goToPrevious = useCallback(() => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const goToNext = useCallback(() => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious]
  );

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children]
  );

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden"
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>;

export const MessageBranchSelector = ({
  className,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className={cn(
        "[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
        className
      )}
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({
  children,
  ...props
}: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn(
        "border-none bg-transparent text-muted-foreground shadow-none",
        className
      )}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

// Mermaid is a few MB: fetched the first time a reply draws a diagram, not with every chat.
const mermaid: DiagramPlugin = {
  name: "mermaid",
  type: "diagram",
  language: "mermaid",
  getMermaid: (config) => ({
    initialize: (next) => void (config = next),
    render: async (id, source) => (await import("@streamdown/mermaid")).mermaid.getMermaid(config).render(id, source),
  }),
};

const streamdownPlugins = { cjk, code, math, mermaid };

// Links in a reply look like the ones in sent messages: highlighted, with a link icon, a bare address cut short.
// Streamdown's own link stays underneath (it asks before opening a site).
const bare = (text: unknown, href?: string) =>
  typeof text === "string" && !!href && text.replace(/^https?:\/\//, "").replace(/\/$/, "") === href.replace(/^https?:\/\//, "").replace(/\/$/, "");
const components = {
  a: ({ children, ...props }: ComponentProps<NonNullable<typeof defaultComponents.a>>) => {
    const A = defaultComponents.a!;
    return (
      <A {...props} className="no-underline hover:underline">
        <ShortLink href={props.href ?? ""}>{bare(children, props.href) ? undefined : children}</ShortLink>
      </A>
    );
  },
};

// While a reply streams, each new word fades in (opacity only, so the browser does it off the main thread),
// linear over 0.7s like the Claude app, so the last few lines trail off from faint to full. The stagger follows the
// server's one word every 25ms, so speed is unchanged. A reply already partway written when it appears (the chat
// opened mid-reply) fades in all at once: a delay per word would hold back what's already there.
// globals.css pins the duration: Streamdown sets 0ms on words already drawn, which cut each fade short the
// moment the next word arrived.
const FADE_MS = 700;
const letters = { animation: "fadeIn", duration: FADE_MS, easing: "linear", sep: "word", stagger: 25 } as const;
const resumed = { ...letters, stagger: 0 } as const;

// A single line break after a finished sentence is the model starting a new paragraph: give it a paragraph's gap.
// Breaks inside code, and before list items, tables, quotes and headings, stay as they are; so do lines without
// end punctuation (an address, a short list of names), which keep showing as written.
const PARAGRAPH = /([.!?:;)"'”…])\n(?![\n\s\-*+>|#]|\d+[.)])/g;
export const paragraphs = (md: string) =>
  md
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((part, i) => (i % 2 ? part : part.replace(PARAGRAPH, "$1\n\n")))
    .join("");

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => {
    const [startedEmpty] = useState(() => String(props.children ?? "").length < 40);
    // the fade outlives the stream by one fade: dropping it the moment the reply ends snaps the last words to full
    const [wasAnimating, setWasAnimating] = useState(props.isAnimating);
    const [lingering, setLingering] = useState(false);
    if (props.isAnimating !== wasAnimating) {
      setWasAnimating(props.isAnimating);
      setLingering(!props.isAnimating);
    }
    useEffect(() => {
      if (!lingering) return;
      const t = setTimeout(() => setLingering(false), FADE_MS);
      return () => clearTimeout(t);
    }, [lingering]);
    const animating = props.isAnimating || lingering;
    return (
      <Streamdown
        // only while streaming: on a finished reply it would fade in every letter again
        animated={animating ? (startedEmpty ? letters : resumed) : undefined}
        // closing half-written markdown is for text still arriving; on a finished reply it "closes" a lone
        // underscore (a subject like "Automation_ Verification") with a stray _ at the very end
        parseIncompleteMarkdown={!!props.isAnimating}
        className={cn(
          // Single line breaks show as written (like Telegram), not merged into one paragraph.
          "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:whitespace-pre-line [&_hr]:my-8",
          className
        )}
        plugins={streamdownPlugins}
        components={components}
        {...props}
        isAnimating={animating}
      >
        {typeof props.children === "string" ? paragraphs(props.children) : props.children}
      </Streamdown>
    );
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating
);

MessageResponse.displayName = "MessageResponse";

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      "mt-4 flex w-full items-center justify-between gap-4",
      className
    )}
    {...props}
  >
    {children}
  </div>
);
