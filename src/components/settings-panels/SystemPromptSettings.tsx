import React, { useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { SummaryPromptSettings } from './SummaryPromptSettings';
import { CompactionPromptSettings } from './CompactionPromptSettings';

/**
 * Settings → System Prompts.
 *
 * One home for every prompt OmniFex composes and sends on the user's behalf,
 * rather than scattering a tab per prompt across the top-level bar. Sub-tabs
 * follow the Chats tab's `variant="line"` pattern.
 *
 * Add a sub-tab here whenever a new OmniFex-authored prompt ships — the CLI
 * review prompt (`cliReview.promptTemplate`) is the obvious next one.
 */
export const SystemPromptSettings: React.FC = () => {
  const [activeTab, setActiveTab] = useState('summaries');

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} variant="line" className="w-full">
      <TabsList>
        <TabsTrigger value="summaries">Session summaries</TabsTrigger>
        <TabsTrigger value="compactions">Compactions</TabsTrigger>
      </TabsList>

      <TabsContent value="summaries" className="mt-4">
        <SummaryPromptSettings />
      </TabsContent>

      <TabsContent value="compactions" className="mt-4">
        <CompactionPromptSettings />
      </TabsContent>
    </Tabs>
  );
};
