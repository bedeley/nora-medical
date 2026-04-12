"use client";

export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { AddProductDialog, DeleteProductDialog, EditProductDialogById } from "./components/ProductDialogs";
import { ProductsBulkActionsBar } from "./components/ProductsBulkActionsBar";
import { ProductsDesktopTable } from "./components/ProductsDesktopTable";
import { ProductsFiltersCard } from "./components/ProductsFiltersCard";
import { ProductsHeaderActions } from "./components/ProductsHeaderActions";
import { ProductsLoadingState } from "./components/ProductsLoadingState";
import { ProductsMobileList } from "./components/ProductsMobileList";
import { ProductsOverviewCards } from "./components/ProductsOverviewCards";
import { ProductsPagination } from "./components/ProductsPagination";
import { ProductsPageIntro } from "./components/ProductsPageIntro";
import { ArchiveReasonDialog, SaveFilterDialog } from "./components/ProductsUtilityDialogs";
import { useAdminProductsPageState } from "./useAdminProductsPageState";

function AdminProductsContent() {
  const state = useAdminProductsPageState();
  const renderAddProductAction = () => <AddProductDialog suppliers={state.suppliers} />;

  return (
    <section className="container mx-auto space-y-6 py-8">
      <ArchiveReasonDialog
        open={state.archiveReasonOpen}
        value={state.archiveReasonInput}
        onValueChange={state.handleArchiveReasonInputChange}
        onCancel={state.cancelArchiveReason}
        onConfirm={state.confirmArchiveReason}
      />
      <SaveFilterDialog
        open={state.saveFilterOpen}
        value={state.saveFilterName}
        onValueChange={state.setSaveFilterName}
        onCancel={state.closeSaveFilter}
        onConfirm={state.confirmSaveFilter}
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <ProductsPageIntro />
        <ProductsHeaderActions
          isAdmin={state.isAdmin}
          bulkMinMarginOpen={state.bulkMinMarginOpen}
          onBulkMinMarginOpenChange={state.handleBulkMinMarginOpenChange}
          bulkMinMarginCategory={state.bulkMinMarginCategory}
          onBulkMinMarginCategoryChange={state.handleBulkMinMarginCategoryChange}
          bulkMinMarginValue={state.bulkMinMarginValue}
          onBulkMinMarginValueChange={state.handleBulkMinMarginValueChange}
          bulkMinMarginReason={state.bulkMinMarginReason}
          onBulkMinMarginReasonChange={state.handleBulkMinMarginReasonChange}
          bulkMinMarginSaving={state.bulkMinMarginSaving}
          onBulkSetMinMargin={() => {
            void state.handleBulkSetMinMargin();
          }}
          addProductAction={renderAddProductAction()}
        />
      </div>

      {state.error || state.isLoading ? (
        <ProductsLoadingState error={Boolean(state.error)} onRetry={() => { void state.retryProducts(); }} />
      ) : (
        <>
          <ProductsOverviewCards
            stats={state.overviewStats}
            isAdmin={state.isAdmin}
            canShowCost={state.canShowCost}
          />

          <ProductsFiltersCard
            searchInput={state.searchInput}
            searchInputRef={state.searchInputRef}
            onSearchInputChange={state.handleSearchInputChange}
            onClearSearch={state.clearSearch}
            pageSize={state.pageSize}
            onPageSizeChange={state.handlePageSizeChange}
            categoryFilter={state.categoryFilter}
            onCategoryFilterChange={state.handleCategoryFilterChange}
            supplierFilter={state.supplierFilter}
            onSupplierFilterChange={state.handleSupplierFilterChange}
            assignableSuppliers={state.assignableSuppliers}
            stockFilter={state.stockFilter}
            onStockFilterChange={state.handleStockFilterChange}
            sortField={state.sortField}
            sortDir={state.sortDir}
            onSortSelection={state.handleSortSelection}
            includeArchived={state.includeArchived}
            onIncludeArchivedChange={state.handleIncludeArchivedChange}
            isAdmin={state.isAdmin}
            showCost={state.showCost}
            onShowCostChange={state.handleShowCostChange}
            savedFilters={state.savedFilters}
            onOpenSaveFilter={state.openSaveFilter}
            onApplySavedFilter={state.onApplySavedFilter}
            onRemoveSavedFilter={state.onRemoveSavedFilter}
            onClearFilters={state.clearAllFilters}
            hasActiveFilters={state.hasActiveFilters}
            activeFilterCount={state.activeFilterCount}
            productsLength={state.products.length}
            total={state.total}
          />

          <ProductsBulkActionsBar
            selectedCount={state.selectedCount}
            onClearSelection={state.clearSelection}
            onBulkArchive={(archived) => {
              void state.handleBulkArchive(archived);
            }}
            bulkSupplierOpen={state.bulkSupplierOpen}
            onBulkSupplierOpenChange={state.handleBulkSupplierOpenChange}
            bulkSupplierId={state.bulkSupplierId}
            onBulkSupplierIdChange={state.handleBulkSupplierIdChange}
            bulkSupplierName={state.bulkSupplierName}
            onBulkSupplierNameChange={state.handleBulkSupplierNameChange}
            bulkSupplierReason={state.bulkSupplierReason}
            onBulkSupplierReasonChange={state.handleBulkSupplierReasonChange}
            bulkSaving={state.bulkSaving}
            onBulkAssignSupplier={() => {
              void state.handleBulkAssignSupplier();
            }}
            assignableSuppliers={state.assignableSuppliers}
            onExportSelected={state.exportSelected}
          />

          <ProductsDesktopTable
            products={state.products}
            total={state.total}
            search={state.search}
            canShowCost={state.canShowCost}
            columnWidths={state.columnWidths}
            selectedIds={state.selectedIds}
            allVisibleSelected={state.allVisibleSelected}
            sortField={state.sortField}
            sortDir={state.sortDir}
            addProductAction={renderAddProductAction()}
            onToggleSelectAllVisible={state.toggleSelectAllVisible}
            onToggleSelected={state.toggleSelected}
            onSortColumn={state.handleSortColumn}
            onStartResize={state.startResize}
            onEdit={state.openEditDialog}
            onDelete={state.openDeleteDialog}
            onArchiveToggle={state.handleArchiveToggle}
            onClearFilters={state.clearAllFilters}
          />

          <ProductsMobileList
            products={state.products}
            search={state.search}
            canShowCost={state.canShowCost}
            selectedIds={state.selectedIds}
            addProductAction={renderAddProductAction()}
            onToggleSelected={state.toggleSelected}
            onEdit={state.openEditDialog}
            onArchiveToggle={state.handleArchiveToggle}
            onDelete={state.openDeleteDialog}
            onClearFilters={state.clearAllFilters}
          />

          <ProductsPagination
            page={state.page}
            total={state.total}
            totalPages={state.totalPages}
            onPageChange={state.handlePageChange}
          />

          {state.editId ? (
            <EditProductDialogById
              id={state.editId}
              products={state.products}
              isAdmin={state.isAdmin}
              suppliers={state.suppliers}
              onClose={state.closeEditDialog}
            />
          ) : null}

          {state.deleteId ? (
            <DeleteProductDialog
              id={state.deleteId}
              name={state.products.find((product) => product.id === state.deleteId)?.name || "Product"}
              open={true}
              onOpenChange={state.handleDeleteOpenChange}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

export default function AdminProductsPage() {
  return (
    <Suspense
      fallback={
        <section className="container mx-auto py-8">
          <h1 className="mb-2 text-2xl font-semibold">Products</h1>
          <p className="text-sm text-muted-foreground">Loading products...</p>
        </section>
      }
    >
      <AdminProductsContent />
    </Suspense>
  );
}
