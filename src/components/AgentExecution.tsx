import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  ArrowLeft, 
  Play, 
  StopCircle, 
  FolderOpen, 
  Terminal,
  AlertCircle,
  Loader2,
  Copy,
  ChevronDown,
  Maximize2,
  X
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover } from "@/components/ui/popover";
import { api, type Agent } from "@/lib/api";
import { cn } from "@/lib/utils";
import { open } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { StreamMessage } from "./StreamMessage";
import { ExecutionControlBar } from "./ExecutionControlBar";
import { ErrorBoundary } from "./ErrorBoundary";
import { enhanceMessages, type EnhancedMessage } from "@/types/enhanced-messages";
import { useVirtualizer } from "@tanstack/react-virtual";

interface AgentExecutionProps {
  /**
   * The agent to execute
   */
  agent: Agent;
  /**
   * Callback to go back to the agents list
   */
  onBack: () => void;
  /**
   * Optional className for styling
   */
  className?: string;
}

export interface ClaudeStreamMessage {
  type: "system" | "assistant" | "user" | "result";
  subtype?: string;
  message?: {
    content?: any[];
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  [key: string]: any;
}

/**
 * AgentExecution component for running CC agents
 * 
 * @example
 * <AgentExecution agent={agent} onBack={() => setView('list')} />
 */
export const AgentExecution: React.FC<AgentExecutionProps> = ({
  agent,
  onBack,
  className,
}) => {
  const [projectPath, setProjectPath] = useState("");
  const [task, setTask] = useState("");
  const [model, setModel] = useState(agent.model || "sonnet");
  const [isRunning, setIsRunning] = useState(false);
  const [messages, setMessages] = useState<ClaudeStreamMessage[]>([]);
  const [enhancedMessages, setEnhancedMessages] = useState<EnhancedMessage[]>([]);
  const [rawJsonlOutput, setRawJsonlOutput] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copyPopoverOpen, setCopyPopoverOpen] = useState(false);
  
  // Execution stats
  const [executionStartTime, setExecutionStartTime] = useState<number | null>(null);
  const [totalTokens, setTotalTokens] = useState(0);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [hasUserScrolled, setHasUserScrolled] = useState(false);
  const [isFullscreenModalOpen, setIsFullscreenModalOpen] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fullscreenScrollRef = useRef<HTMLDivElement>(null);
  const fullscreenMessagesEndRef = useRef<HTMLDivElement>(null);
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  const elapsedTimeIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Virtualizers for efficient, smooth scrolling of potentially very long outputs
  const rowVirtualizer = useVirtualizer({
    count: enhancedMessages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 150, // fallback estimate; dynamically measured afterwards
    overscan: 5,
  });

  const fullscreenRowVirtualizer = useVirtualizer({
    count: enhancedMessages.length,
    getScrollElement: () => fullscreenScrollRef.current,
    estimateSize: () => 150,
    overscan: 5,
  });

  useEffect(() => {
    // Clean up listeners on unmount
    return () => {
      unlistenRefs.current.forEach(unlisten => unlisten());
      if (elapsedTimeIntervalRef.current) {
        clearInterval(elapsedTimeIntervalRef.current);
      }
    };
  }, []);

  // Check if user is at the very bottom of the scrollable container
  const isAtBottom = () => {
    const container = isFullscreenModalOpen ? fullscreenScrollRef.current : scrollContainerRef.current;
    if (container) {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      return distanceFromBottom < 1;
    }
    return true;
  };

  useEffect(() => {
    if (enhancedMessages.length === 0) return;

    // Auto-scroll only if the user has not manually scrolled OR they are still at the bottom
    const shouldAutoScroll = !hasUserScrolled || isAtBottom();

    if (shouldAutoScroll) {
      if (isFullscreenModalOpen) {
        fullscreenRowVirtualizer.scrollToIndex(enhancedMessages.length - 1, { align: "end", behavior: "smooth" });
      } else {
        rowVirtualizer.scrollToIndex(enhancedMessages.length - 1, { align: "end", behavior: "smooth" });
      }
    }
  }, [enhancedMessages.length, hasUserScrolled, isFullscreenModalOpen, rowVirtualizer, fullscreenRowVirtualizer]);

  // Update elapsed time while running
  useEffect(() => {
    if (isRunning && executionStartTime) {
      elapsedTimeIntervalRef.current = setInterval(() => {
        setElapsedTime(Math.floor((Date.now() - executionStartTime) / 1000));
      }, 100);
    } else {
      if (elapsedTimeIntervalRef.current) {
        clearInterval(elapsedTimeIntervalRef.current);
      }
    }
    
    return () => {
      if (elapsedTimeIntervalRef.current) {
        clearInterval(elapsedTimeIntervalRef.current);
      }
    };
  }, [isRunning, executionStartTime]);

  // Calculate total tokens from messages
  useEffect(() => {
    const tokens = messages.reduce((total, msg) => {
      if (msg.message?.usage) {
        return total + msg.message.usage.input_tokens + msg.message.usage.output_tokens;
      }
      if (msg.usage) {
        return total + msg.usage.input_tokens + msg.usage.output_tokens;
      }
      return total;
    }, 0);
    setTotalTokens(tokens);
  }, [messages]);

  // Enhance messages whenever they change
  useEffect(() => {
    const enhanced = enhanceMessages(messages);
    setEnhancedMessages(enhanced);
  }, [messages]);

  const handleSelectPath = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Project Directory"
      });
      
      if (selected) {
        setProjectPath(selected as string);
        setError(null); // Clear any previous errors
      }
    } catch (err) {
      console.error("Failed to select directory:", err);
      // More detailed error logging
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to select directory: ${errorMessage}`);
    }
  };

  const handleExecute = async () => {
    if (!projectPath || !task.trim()) return;

    try {
      setIsRunning(true);
      setError(null);
      setMessages([]);
      setRawJsonlOutput([]);
      setExecutionStartTime(Date.now());
      setElapsedTime(0);
      setTotalTokens(0);

      // Set up event listeners
      const outputUnlisten = await listen<string>("agent-output", (event) => {
        try {
          // Store raw JSONL
          setRawJsonlOutput(prev => [...prev, event.payload]);
          
          // Parse and display
          const message = JSON.parse(event.payload) as ClaudeStreamMessage;
          setMessages(prev => [...prev, message]);
        } catch (err) {
          console.error("Failed to parse message:", err, event.payload);
        }
      });

      const errorUnlisten = await listen<string>("agent-error", (event) => {
        console.error("Agent error:", event.payload);
        setError(event.payload);
      });

      const completeUnlisten = await listen<boolean>("agent-complete", (event) => {
        setIsRunning(false);
        setExecutionStartTime(null);
        if (!event.payload) {
          setError("Agent execution failed");
        }
      });

      unlistenRefs.current = [outputUnlisten, errorUnlisten, completeUnlisten];

      // Execute the agent with model override
      await api.executeAgent(agent.id!, projectPath, task, model);
    } catch (err) {
      console.error("Failed to execute agent:", err);
      setError("Failed to execute agent");
      setIsRunning(false);
      setExecutionStartTime(null);
    }
  };

  const handleStop = async () => {
    try {
      // TODO: Implement actual stop functionality via API
      // For now, just update the UI state
      setIsRunning(false);
      setExecutionStartTime(null);
      
      // Clean up listeners
      unlistenRefs.current.forEach(unlisten => unlisten());
      unlistenRefs.current = [];
      
      // Add a message indicating execution was stopped
      setMessages(prev => [...prev, {
        type: "result",
        subtype: "error",
        is_error: true,
        result: "Execution stopped by user",
        duration_ms: elapsedTime * 1000,
        usage: {
          input_tokens: totalTokens,
          output_tokens: 0
        }
      }]);
    } catch (err) {
      console.error("Failed to stop agent:", err);
    }
  };

  const handleBackWithConfirmation = () => {
    if (isRunning) {
      // Show confirmation dialog before navigating away during execution
      const shouldLeave = window.confirm(
        "An agent is currently running. If you navigate away, the agent will continue running in the background. You can view running sessions in the 'Running Sessions' tab within CC Agents.\n\nDo you want to continue?"
      );
      if (!shouldLeave) {
        return;
      }
    }
    
    // Clean up listeners but don't stop the actual agent process
    unlistenRefs.current.forEach(unlisten => unlisten());
    unlistenRefs.current = [];
    
    // Navigate back
    onBack();
  };

  const handleCopyAsJsonl = async () => {
    const jsonl = rawJsonlOutput.join('\n');
    await navigator.clipboard.writeText(jsonl);
    setCopyPopoverOpen(false);
  };

  const handleCopyAsMarkdown = async () => {
    let markdown = `# Agent Execution: ${agent.name}\n\n`;
    markdown += `**Task:** ${task}\n`;
    markdown += `**Model:** ${model === 'opus' ? 'Claude 4 Opus' : 'Claude 4 Sonnet'}\n`;
    markdown += `**Date:** ${new Date().toISOString()}\n\n`;
    markdown += `---\n\n`;

    for (const msg of messages) {
      if (msg.type === "system" && msg.subtype === "init") {
        markdown += `## System Initialization\n\n`;
        markdown += `- Session ID: \`${msg.session_id || 'N/A'}\`\n`;
        markdown += `- Model: \`${msg.model || 'default'}\`\n`;
        if (msg.cwd) markdown += `- Working Directory: \`${msg.cwd}\`\n`;
        if (msg.tools?.length) markdown += `- Tools: ${msg.tools.join(', ')}\n`;
        markdown += `\n`;
      } else if (msg.type === "assistant" && msg.message) {
        markdown += `## Assistant\n\n`;
        for (const content of msg.message.content || []) {
          if (content.type === "text") {
            markdown += `${content.text}\n\n`;
          } else if (content.type === "tool_use") {
            markdown += `### Tool: ${content.name}\n\n`;
            markdown += `\`\`\`json\n${JSON.stringify(content.input, null, 2)}\n\`\`\`\n\n`;
          }
        }
        if (msg.message.usage) {
          markdown += `*Tokens: ${msg.message.usage.input_tokens} in, ${msg.message.usage.output_tokens} out*\n\n`;
        }
      } else if (msg.type === "user" && msg.message) {
        markdown += `## User\n\n`;
        for (const content of msg.message.content || []) {
          if (content.type === "text") {
            markdown += `${content.text}\n\n`;
          } else if (content.type === "tool_result") {
            markdown += `### Tool Result\n\n`;
            markdown += `\`\`\`\n${content.content}\n\`\`\`\n\n`;
          }
        }
      } else if (msg.type === "result") {
        markdown += `## Execution Result\n\n`;
        if (msg.result) {
          markdown += `${msg.result}\n\n`;
        }
        if (msg.error) {
          markdown += `**Error:** ${msg.error}\n\n`;
        }
        if (msg.cost_usd !== undefined) {
          markdown += `- **Cost:** $${msg.cost_usd.toFixed(4)} USD\n`;
        }
        if (msg.duration_ms !== undefined) {
          markdown += `- **Duration:** ${(msg.duration_ms / 1000).toFixed(2)}s\n`;
        }
        if (msg.num_turns !== undefined) {
          markdown += `- **Turns:** ${msg.num_turns}\n`;
        }
        if (msg.usage) {
          const total = msg.usage.input_tokens + msg.usage.output_tokens;
          markdown += `- **Total Tokens:** ${total} (${msg.usage.input_tokens} in, ${msg.usage.output_tokens} out)\n`;
        }
      }
    }

    await navigator.clipboard.writeText(markdown);
    setCopyPopoverOpen(false);
  };

  const renderIcon = () => {
    const Icon = agent.icon in AGENT_ICONS ? AGENT_ICONS[agent.icon as keyof typeof AGENT_ICONS] : Terminal;
    return <Icon className="h-5 w-5" />;
  };

  return (
    <div className={cn("flex flex-col h-full bg-background", className)}>
      <div className="w-full max-w-5xl mx-auto h-full flex flex-col">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="flex items-center justify-between p-4 border-b border-border"
        >
          <div className="flex items-center space-x-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={handleBackWithConfirmation}
              className="h-8 w-8"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-2">
              {renderIcon()}
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold">{agent.name}</h2>
                  {isRunning && (
                    <div className="flex items-center gap-1">
                      <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                      <span className="text-xs text-green-600 font-medium">Running</span>
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {isRunning ? "Click back to return to main menu - view in CC Agents > Running Sessions" : "Execute CC Agent"}
                </p>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {messages.length > 0 && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsFullscreenModalOpen(true)}
                  className="flex items-center gap-2"
                >
                  <Maximize2 className="h-4 w-4" />
                  Fullscreen
                </Button>
                <Popover
                  trigger={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="flex items-center gap-2"
                    >
                      <Copy className="h-4 w-4" />
                      Copy Output
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                  }
                  content={
                    <div className="w-44 p-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start"
                        onClick={handleCopyAsJsonl}
                      >
                        Copy as JSONL
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start"
                        onClick={handleCopyAsMarkdown}
                      >
                        Copy as Markdown
                      </Button>
                    </div>
                  }
                  open={copyPopoverOpen}
                  onOpenChange={setCopyPopoverOpen}
                  align="end"
                />
              </>
            )}
          </div>
        </motion.div>
        
        {/* Configuration */}
        <div className="p-4 border-b border-border space-y-4">
          {/* Error display */}
          {error && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive flex items-center gap-2"
            >
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              {error}
            </motion.div>
          )}

          {/* Project Path */}
          <div className="space-y-2">
            <Label>Project Path</Label>
            <div className="flex gap-2">
              <Input
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                placeholder="Select or enter project path"
                disabled={isRunning}
                className="flex-1"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={handleSelectPath}
                disabled={isRunning}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Model Selection */}
          <div className="space-y-2">
            <Label>Model</Label>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => !isRunning && setModel("sonnet")}
                className={cn(
                  "flex-1 px-3.5 py-2 rounded-full border-2 font-medium transition-all text-sm",
                  !isRunning && "hover:scale-[1.02] active:scale-[0.98]",
                  isRunning && "opacity-50 cursor-not-allowed",
                  model === "sonnet" 
                    ? "border-primary bg-primary text-primary-foreground shadow-lg" 
                    : "border-muted-foreground/30 hover:border-muted-foreground/50"
                )}
                disabled={isRunning}
              >
                <div className="flex items-center justify-center gap-2">
                  <div className={cn(
                    "w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center flex-shrink-0",
                    model === "sonnet" ? "border-primary-foreground" : "border-current"
                  )}>
                    {model === "sonnet" && (
                      <div className="w-1.5 h-1.5 rounded-full bg-primary-foreground" />
                    )}
                  </div>
                  <span>Claude 4 Sonnet</span>
                </div>
              </button>
              
              <button
                type="button"
                onClick={() => !isRunning && setModel("opus")}
                className={cn(
                  "flex-1 px-3.5 py-2 rounded-full border-2 font-medium transition-all text-sm",
                  !isRunning && "hover:scale-[1.02] active:scale-[0.98]",
                  isRunning && "opacity-50 cursor-not-allowed",
                  model === "opus" 
                    ? "border-primary bg-primary text-primary-foreground shadow-lg" 
                    : "border-muted-foreground/30 hover:border-muted-foreground/50"
                )}
                disabled={isRunning}
              >
                <div className="flex items-center justify-center gap-2">
                  <div className={cn(
                    "w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center flex-shrink-0",
                    model === "opus" ? "border-primary-foreground" : "border-current"
                  )}>
                    {model === "opus" && (
                      <div className="w-1.5 h-1.5 rounded-full bg-primary-foreground" />
                    )}
                  </div>
                  <span>Claude 4 Opus</span>
                </div>
              </button>
            </div>
          </div>

          {/* Task Input */}
          <div className="space-y-2">
            <Label>Task</Label>
            <div className="flex gap-2">
              <Input
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder={agent.default_task || "Enter the task for the agent"}
                disabled={isRunning}
                className="flex-1"
                onKeyPress={(e) => {
                  if (e.key === "Enter" && !isRunning && projectPath && task.trim()) {
                    handleExecute();
                  }
                }}
              />
              <Button
                onClick={isRunning ? handleStop : handleExecute}
                disabled={!projectPath || !task.trim()}
                variant={isRunning ? "destructive" : "default"}
              >
                {isRunning ? (
                  <>
                    <StopCircle className="mr-2 h-4 w-4" />
                    Stop
                  </>
                ) : (
                  <>
                    <Play className="mr-2 h-4 w-4" />
                    Execute
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>

        {/* Output Display */}
        <div className="flex-1 flex flex-col min-h-0">
          <div 
            ref={scrollContainerRef}
            className="flex-1 w-full overflow-y-auto p-6 space-y-8"
            onScroll={() => {
              // Mark that user has scrolled manually
              if (!hasUserScrolled) {
                setHasUserScrolled(true);
              }
              
              // If user scrolls back to bottom, re-enable auto-scroll
              if (isAtBottom()) {
                setHasUserScrolled(false);
              }
            }}
          >
            <div ref={messagesContainerRef}>
            {enhancedMessages.length === 0 && !isRunning && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <Terminal className="h-16 w-16 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">Ready to Execute</h3>
                <p className="text-sm text-muted-foreground">
                  Select a project path and enter a task to run the agent
                </p>
              </div>
            )}

            {isRunning && enhancedMessages.length === 0 && (
              <div className="flex items-center justify-center h-full">
                <div className="flex items-center gap-3">
                  <Loader2 className="h-6 w-6 animate-spin" />
                  <span className="text-sm text-muted-foreground">Initializing agent...</span>
                </div>
              </div>
            )}

            <div
              className="relative w-full max-w-5xl mx-auto"
              style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
              <AnimatePresence>
                {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                  const message = enhancedMessages[virtualItem.index];
                  return (
                    <motion.div
                      key={virtualItem.key}
                      data-index={virtualItem.index}
                      ref={(el) => el && rowVirtualizer.measureElement(el)}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2 }}
                      className="absolute inset-x-4 pb-4"
                      style={{ top: virtualItem.start }}
                    >
                      <ErrorBoundary>
                        <StreamMessage message={message} streamMessages={enhancedMessages} />
                      </ErrorBoundary>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
            
            <div ref={messagesEndRef} />
            </div>
          </div>
        </div>
      </div>

      {/* Floating Execution Control Bar */}
      <ExecutionControlBar
        isExecuting={isRunning}
        onStop={handleStop}
        totalTokens={totalTokens}
        elapsedTime={elapsedTime}
      />

      {/* Fullscreen Modal */}
      {isFullscreenModalOpen && (
        <div className="fixed inset-0 z-50 bg-background flex flex-col">
          {/* Modal Header */}
          <div className="flex items-center justify-between p-4 border-b border-border">
            <div className="flex items-center gap-2">
              {renderIcon()}
              <h2 className="text-lg font-semibold">{agent.name} - Output</h2>
              {isRunning && (
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                  <span className="text-xs text-green-600 font-medium">Running</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Popover
                trigger={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex items-center gap-2"
                  >
                    <Copy className="h-4 w-4" />
                    Copy Output
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                }
                content={
                  <div className="w-44 p-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start"
                      onClick={handleCopyAsJsonl}
                    >
                      Copy as JSONL
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start"
                      onClick={handleCopyAsMarkdown}
                    >
                      Copy as Markdown
                    </Button>
                  </div>
                }
                open={copyPopoverOpen}
                onOpenChange={setCopyPopoverOpen}
                align="end"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsFullscreenModalOpen(false)}
                className="flex items-center gap-2"
              >
                <X className="h-4 w-4" />
                Close
              </Button>
            </div>
          </div>

          {/* Modal Content */}
          <div className="flex-1 overflow-hidden p-6">
            <div 
              ref={fullscreenScrollRef}
              className="h-full overflow-y-auto space-y-8"
              onScroll={() => {
                // Mark that user has scrolled manually
                if (!hasUserScrolled) {
                  setHasUserScrolled(true);
                }
                
                // If user scrolls back to bottom, re-enable auto-scroll
                if (isAtBottom()) {
                  setHasUserScrolled(false);
                }
              }}
            >
              {enhancedMessages.length === 0 && !isRunning && (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <Terminal className="h-16 w-16 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-medium mb-2">Ready to Execute</h3>
                  <p className="text-sm text-muted-foreground">
                    Select a project path and enter a task to run the agent
                  </p>
                </div>
              )}

              {isRunning && enhancedMessages.length === 0 && (
                <div className="flex items-center justify-center h-full">
                  <div className="flex items-center gap-3">
                    <Loader2 className="h-6 w-6 animate-spin" />
                    <span className="text-sm text-muted-foreground">Initializing agent...</span>
                  </div>
                </div>
              )}

              <div
                className="relative w-full max-w-5xl mx-auto"
                style={{ height: `${fullscreenRowVirtualizer.getTotalSize()}px` }}
              >
                <AnimatePresence>
                  {fullscreenRowVirtualizer.getVirtualItems().map((virtualItem) => {
                    const message = enhancedMessages[virtualItem.index];
                    return (
                      <motion.div
                        key={virtualItem.key}
                        data-index={virtualItem.index}
                        ref={(el) => el && fullscreenRowVirtualizer.measureElement(el)}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2 }}
                        className="absolute inset-x-4 pb-4"
                        style={{ top: virtualItem.start }}
                      >
                        <ErrorBoundary>
                          <StreamMessage message={message} streamMessages={enhancedMessages} />
                        </ErrorBoundary>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
              
              <div ref={fullscreenMessagesEndRef} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Import AGENT_ICONS for icon rendering
import { AGENT_ICONS } from "./CCAgents"; 
