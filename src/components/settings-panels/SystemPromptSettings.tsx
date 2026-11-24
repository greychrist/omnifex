import React, { useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { SummaryPromptSettings } from './SummaryPromptSettings';
import { CompactionPromptSettings } from './CompactionPromptSettings';

// The CLI review prompt is deliberately absent: it is not user-editable.
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
