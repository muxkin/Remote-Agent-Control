<script setup lang="ts">
import { paths, type IconName } from './icon-paths';

withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 22 });
</script>

<template>
  <svg
    aria-hidden="true"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="name === 'more' ? 4 : 1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path :d="paths[name]" />
  </svg>
</template>
