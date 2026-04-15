import React from "react";
import { Card } from "@/components/ui/card";
import { SlashCommandsManager } from "@/components/SlashCommandsManager";

export const CommandsSettings: React.FC = () => {
  return (
    <Card className="p-6">
      <SlashCommandsManager className="p-0" />
    </Card>
  );
};
