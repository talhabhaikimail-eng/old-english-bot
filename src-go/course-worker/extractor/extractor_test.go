package extractor

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNaturalSort(t *testing.T) {
	files := []string{
		"course.part10.rar",
		"course.part1.rar",
		"course.part2.rar",
		"course.part20.rar",
	}

	NaturalSort(files)

	expected := []string{
		"course.part1.rar",
		"course.part2.rar",
		"course.part10.rar",
		"course.part20.rar",
	}

	for i, f := range files {
		if f != expected[i] {
			t.Fatalf("expected index %d to be %s, got %s", i, expected[i], f)
		}
	}
}

func TestNormalizeVolumes(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "norm_test_*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tempDir)

	files := []string{
		"Udemy_OOPs_in_Python_2024-10.part1_Downloadly.ir.rar",
		"Udemy_OOPs_in_Python_2024-10.part2_Downloadly.ir.rar",
		"Udemy_OOPs_in_Python_2024-10.part5_Downloadly.ir.rar",
	}

	for _, f := range files {
		_ = os.WriteFile(filepath.Join(tempDir, f), []byte("dummy"), 0644)
	}

	ext := NewExtractor(nil)
	if err := ext.NormalizeVolumes(tempDir); err != nil {
		t.Fatal(err)
	}

	expectedFiles := []string{
		"Udemy_OOPs_in_Python_2024-10_Downloadly.ir.part1.rar",
		"Udemy_OOPs_in_Python_2024-10_Downloadly.ir.part2.rar",
		"Udemy_OOPs_in_Python_2024-10_Downloadly.ir.part5.rar",
	}

	for _, ef := range expectedFiles {
		if _, err := os.Stat(filepath.Join(tempDir, ef)); os.IsNotExist(err) {
			t.Fatalf("expected normalized file %s to exist", ef)
		}
	}
}
